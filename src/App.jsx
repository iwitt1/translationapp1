import { useState, useRef, useEffect } from "react";
import { supabase } from "./lib/supabase";

/*
========================================================
🌍 AI TRANSLATION
========================================================
*/
async function translateMessage(text, targetLanguage) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are a translation engine.

Translate the message into ${targetLanguage}.
Also detect the original language.

Return ONLY JSON:
{
  "detected_language": "...",
  "translated_text": "..."
}
            `.trim(),
          },
          { role: "user", content: text },
        ],
        temperature: 0,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    return JSON.parse(data.choices[0].message.content);
  } catch (err) {
    console.error("AI error:", err);
    return {
      detected_language: "unknown",
      translated_text: text,
    };
  }
}

/*
========================================================
💬 MESSAGE BUBBLE (CACHE-FIRST)
========================================================
*/
function MessageBubble({ message, userProfile, userId }) {
  const [translatedText, setTranslatedText] = useState(null);
  const [loading, setLoading] = useState(true);

  const targetLanguage = userProfile?.default_language || "en";
  const isSender = message.sender_id === userId;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);

      try {
        const sourceLang = message.source_language;

        // ✅ 1. NO TRANSLATION NEEDED
        if (!sourceLang || sourceLang === targetLanguage) {
          setTranslatedText(message.original_text);
          setLoading(false);
          return;
        }

        // ✅ 2. CACHE FIRST
        const { data: cached } = await supabase
          .from("message_translations")
          .select("translated_text")
          .eq("message_id", message.id)
          .eq("language", targetLanguage)
          .maybeSingle();

        if (cached?.translated_text) {
          setTranslatedText(cached.translated_text);
          setLoading(false);
          return;
        }

        // ✅ 3. TRANSLATE ONLY IF NEEDED
        const result = await translateMessage(
          message.original_text,
          targetLanguage
        );

        if (cancelled) return;

        setTranslatedText(result.translated_text);

        // ✅ 4. CACHE (UPSERT SAFE)
        await supabase.from("message_translations").upsert(
          {
            message_id: message.id,
            language: targetLanguage,
            translated_text: result.translated_text,
          },
          { onConflict: "message_id,language" }
        );
      } catch (err) {
        console.error(err);
        setTranslatedText(message.original_text);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();

    return () => (cancelled = true);
  }, [message.id, targetLanguage]);

  return (
    <div className={`flex ${isSender ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isSender
            ? "bg-blue-500 text-white"
            : "bg-gray-200 text-gray-900"
        }`}
      >
        <p className="text-sm">{loading ? "..." : translatedText}</p>

        <p className={`mt-1 text-xs ${isSender ? "text-blue-100" : "text-gray-500"}`}>
          {message.original_text}
        </p>
      </div>
    </div>
  );
}

/*
========================================================
🚀 MAIN APP
========================================================
*/
export default function App() {
  const [username, setUsername] = useState(
    localStorage.getItem("chat_username") || ""
  );

  const [userProfile, setUserProfile] = useState(() => {
    const stored = localStorage.getItem("chat_user_profile");
    return stored ? JSON.parse(stored) : null;
  });

  const [tempName, setTempName] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const bottomRef = useRef(null);

  /*
  ========================================================
  LOGIN
  ========================================================
  */
  async function handleJoin() {
    if (!tempName.trim()) return;

    const user_id = tempName.trim();

    let { data } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user_id)
      .maybeSingle();

    if (!data) {
      const { data: inserted } = await supabase
        .from("user_profiles")
        .insert([
          {
            user_id,
            display_name: user_id,
            default_language: "en",
          },
        ])
        .select()
        .single();

      data = inserted;
    }

    localStorage.setItem("chat_username", user_id);
    localStorage.setItem("chat_user_profile", JSON.stringify(data));

    setUsername(user_id);
    setUserProfile(data);
  }

  /*
  ========================================================
  LOAD + REALTIME
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true })
      .then(({ data }) => setMessages(data || []));

    const channel = supabase
      .channel("messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          setMessages((prev) => [...prev, payload.new]);
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [username]);

  /*
  ========================================================
  SEND MESSAGE (DETECTION HERE ✅)
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim()) return;

    // ✅ Detect language ONCE here
    const detection = await translateMessage(input, "en");

    await supabase.from("messages").insert([
      {
        sender_id: username,
        original_text: input,
        source_language: detection.detected_language,
      },
    ]);

    setInput("");
  }

  /*
  ========================================================
  LOGIN UI
  ========================================================
  */
  if (!username) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-sm bg-white border rounded p-6 space-y-4">
          <h1 className="text-lg font-semibold">
            Join Translation Chat MVP
          </h1>

          <input
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="Enter a username"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
          />

          <button
            onClick={handleJoin}
            className="w-full bg-blue-500 text-white py-2 rounded text-sm"
          >
            Join Chat
          </button>
        </div>
      </main>
    );
  }

  /*
  ========================================================
  CHAT UI
  ========================================================
  */
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md h-[80vh] bg-white border rounded flex flex-col">

        <div className="p-4 border-b font-semibold">
          Chat ({username}) — {userProfile?.default_language}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              userProfile={userProfile}
              userId={username}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="p-3 border-t flex gap-2">
          <input
            className="flex-1 border rounded px-3 py-2 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
          />

          <button
            onClick={sendMessage}
            className="bg-blue-500 text-white px-4 rounded text-sm"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}