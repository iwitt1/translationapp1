import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";

/*
========================================================
🌐 API CONFIG (LOCAL + PROD SAFE)
========================================================
*/
const API_URL =
  import.meta.env.DEV
    ? "http://localhost:3001/api/translate"
    : "/api/translate";

/*
========================================================
💬 MESSAGE BUBBLE
========================================================
*/
function MessageBubble({ message, userProfile, userId }) {
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(true);

  const targetLanguage = userProfile?.default_language || "en";
  const isSender = message.sender_id === userId;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading(true);

        const sourceLang = message.source_language;

        // ✅ 1. NO TRANSLATION NEEDED
        if (!sourceLang || sourceLang === targetLanguage) {
          setTranslatedText(message.original_text);
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
          return;
        }

        // ✅ 3. BACKEND TRANSLATION
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: message.original_text,
            targetLanguage,
            mode: "translate",
          }),
        });

        if (!res.ok) {
          console.error("API failed:", await res.text());
          throw new Error("API failed");
        }

        const result = await res.json();

        if (cancelled) return;

        const finalText =
          result?.translated_text || message.original_text;

        setTranslatedText(finalText);

        // ✅ 4. CACHE RESULT
        await supabase.from("message_translations").upsert(
          {
            message_id: message.id,
            language: targetLanguage,
            translated_text: finalText,
          },
          { onConflict: "message_id,language" }
        );
      } catch (err) {
        console.error("Translation error:", err);
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
        <p className="text-sm">
          {loading ? "..." : translatedText}
        </p>

        <p className="mt-1 text-xs opacity-70">
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
  LOAD MESSAGES
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
  SEND MESSAGE (DETECT ONCE)
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim()) return;

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: input,
          mode: "detect",
        }),
      });

      if (!res.ok) {
        console.error("Detect failed:", await res.text());
      }

      const detection = res.ok ? await res.json() : null;

      await supabase.from("messages").insert([
        {
          sender_id: username,
          original_text: input,
          source_language:
            detection?.detected_language || "unknown",
        },
      ]);

      setInput("");
    } catch (err) {
      console.error("Send error:", err);
    }
  }

  /*
  ========================================================
  LOGIN UI
  ========================================================
  */
  if (!username) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="p-6 border rounded">
          <input
            placeholder="Username"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
          />
          <button onClick={handleJoin}>Join</button>
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
    <main className="min-h-screen flex items-center justify-center">
      <div className="w-full max-w-md h-[80vh] flex flex-col border">

        <div className="p-4 border-b">
          {username} ({userProfile?.default_language})
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
        </div>

        <div className="p-3 border-t flex gap-2">
          <input
            className="flex-1 border px-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button onClick={sendMessage}>Send</button>
        </div>
      </div>
    </main>
  );
}