import { useState, useRef, useEffect } from "react";
import { supabase } from "./lib/supabase";

/*
========================================================
🌍 TRANSLATION FUNCTION
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
You are a real-time translator.

- Detect the source language
- Translate into: ${targetLanguage}

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

    const content = data?.choices?.[0]?.message?.content;
    return JSON.parse(content);
  } catch (err) {
    console.error("Translation error:", err);
    return {
      detected_language: "unknown",
      translated_text: text,
    };
  }
}

/*
========================================================
💬 MESSAGE BUBBLE (FIXED LOGIC)
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
        let sourceLang = message.source_language;

        // -----------------------------------------
        // 1. Detect language if missing
        // -----------------------------------------
        if (!sourceLang) {
          const result = await translateMessage(
            message.original_text,
            targetLanguage
          );

          sourceLang = result.detected_language;

          // Save detected language back to DB
          await supabase
            .from("messages")
            .update({ source_language: sourceLang })
            .eq("id", message.id);
        }

        // -----------------------------------------
        // 2. Skip if same language
        // -----------------------------------------
        if (sourceLang === targetLanguage) {
          setTranslatedText(message.original_text);
          setLoading(false);
          return;
        }

        // -----------------------------------------
        // 3. Check cache
        // -----------------------------------------
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

        // -----------------------------------------
        // 4. Translate
        // -----------------------------------------
        const result = await translateMessage(
          message.original_text,
          targetLanguage
        );

        if (cancelled) return;

        setTranslatedText(result.translated_text);

        // -----------------------------------------
        // 5. Cache it
        // -----------------------------------------
        await supabase
        .from("message_translations")
        .upsert(
          {
            message_id: message.id,
            language: targetLanguage,
            translated_text: result.translated_text,
          },
          { onConflict: "message_id,language" }
        );,
        ]);
      } catch (err) {
        console.error(err);
        setTranslatedText(message.original_text);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
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
        <p className="text-sm">
          {loading ? "..." : translatedText}
        </p>

        <p className={`mt-1 text-xs ${isSender ? "text-blue-100" : "text-gray-500"}`}>
          {message.original_text}
        </p>
      </div>
    </div>
  );
}

/*
========================================================
🚀 MAIN APP (UNCHANGED UI, FIXED DATA FLOW)
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
  SEND MESSAGE
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim()) return;

    await supabase.from("messages").insert([
      {
        sender_id: username,
        original_text: input,
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

          <div className="text-xs text-gray-500 pt-2">
            Per-user translation + caching enabled
          </div>
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