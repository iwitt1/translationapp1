import { useState, useRef, useEffect } from "react";
import { supabase } from "./lib/supabase";

/*
========================================================
🌍 TRANSLATION FUNCTION (WITH CACHING + GUARDS)
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
            content:
              "Translate the message into the target language. Return JSON: { detected_language, translated_text }",
          },
          {
            role: "user",
            content: `Target language: ${targetLanguage}\nText: ${text}`,
          },
        ],
        temperature: 0,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("OpenAI API error:", data);
      return {
        detected_language: "unknown",
        translated_text: text,
      };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Missing content");

    return JSON.parse(content);
  } catch (err) {
    console.error("Translation failed:", err);
    return {
      detected_language: "unknown",
      translated_text: text,
    };
  }
}

/*
========================================================
💬 MESSAGE BUBBLE (PER-USER TRANSLATION)
========================================================
*/
function MessageBubble({ message, userProfile }) {
  const [translatedText, setTranslatedText] = useState(null);
  const [loading, setLoading] = useState(true);

  const targetLanguage = userProfile?.default_language || "en";

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);

      try {
        // -------------------------------------------------
        // 1. SKIP TRANSLATION IF SAME LANGUAGE
        // -------------------------------------------------
        if (targetLanguage === "en") {
          setTranslatedText(message.original_text);
          setLoading(false);
          return;
        }

        // -------------------------------------------------
        // 2. CHECK CACHE TABLE
        // -------------------------------------------------
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

        // -------------------------------------------------
        // 3. CALL OPENAI IF NOT CACHED
        // -------------------------------------------------
        const result = await translateMessage(
          message.original_text,
          targetLanguage
        );

        if (cancelled) return;

        setTranslatedText(result.translated_text);

        // -------------------------------------------------
        // 4. STORE IN CACHE
        // -------------------------------------------------
        await supabase.from("message_translations").insert([
          {
            message_id: message.id,
            language: targetLanguage,
            translated_text: result.translated_text,
          },
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

  const isSender = message.sender_id === userProfile?.user_id;

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

        <p className="text-xs opacity-60 mt-1">
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
  // -----------------------------
  // USER STATE
  // -----------------------------
  const [username, setUsername] = useState(
    localStorage.getItem("chat_username") || ""
  );

  const [userProfile, setUserProfile] = useState(null);
  const [tempName, setTempName] = useState("");

  /*
  ========================================================
  🧑 HANDLE LOGIN + PROFILE CREATE/LOAD
  ========================================================
  */
  async function handleJoin() {
    if (!tempName.trim()) return;

    const user_id = tempName;

    let { data } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (!data) {
      const newUser = {
        user_id,
        display_name: tempName,
        default_language: "en",
      };

      await supabase.from("user_profiles").insert([newUser]);
      data = newUser;
    }

    localStorage.setItem("chat_username", user_id);
    setUsername(user_id);
    setUserProfile(data);
  }

  /*
  ========================================================
  💬 CHAT STATE
  ========================================================
  */
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const bottomRef = useRef(null);
  const scrollRef = useRef(null);

  /*
  ========================================================
  LOAD MESSAGES
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    async function load() {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      setMessages(data || []);
    }

    load();
  }, [username]);

  /*
  ========================================================
  REALTIME
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    const channel = supabase
      .channel("messages")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new]);
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [username]);

  /*
  ========================================================
  SEND MESSAGE (NO PRE-TRANSLATION ANYMORE)
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
  UI
  ========================================================
  */
  if (!username) {
    return (
      <div className="p-10">
        <input
          placeholder="username"
          value={tempName}
          onChange={(e) => setTempName(e.target.value)}
        />
        <button onClick={handleJoin}>Join</button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="p-2 border-b">
        Chat ({username}) - {userProfile?.default_language}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            userProfile={userProfile}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="p-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="border flex-1"
        />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}