import { useState, useRef, useEffect } from "react";
import { supabase } from "./lib/supabase";

/*
========================================================
🌍 TRANSLATION FUNCTION (AI LAYER - NOW USER AWARE)
========================================================
*/
async function translateMessage(text, targetLanguage = "en") {
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
You are a real-time chat translator.

Task:
- Detect the language of the message
- Translate it into: ${targetLanguage}

Rules:
- Preserve meaning, tone, slang, and intent
- Return ONLY valid JSON:
{ "detected_language": "...", "translated_text": "..." }
            `.trim(),
          },
          { role: "user", content: text },
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

    if (!content) {
      return {
        detected_language: "unknown",
        translated_text: text,
      };
    }

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
💬 MESSAGE BUBBLE
========================================================
*/
function MessageBubble({ message, userId }) {
  const isSender = message.sender_id === userId;

  return (
    <div className={`flex ${isSender ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isSender ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-900"
        }`}
      >
        <p className="text-sm">{message.translated_text}</p>

        {message.original_text && (
          <p className={`mt-1 text-xs ${isSender ? "text-blue-100" : "text-gray-500"}`}>
            {message.original_text}
          </p>
        )}
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
  // -----------------------------------------------------
  // 🧑 USER STATE
  // -----------------------------------------------------
  const [username, setUsername] = useState(() => {
    return localStorage.getItem("chat_username") || "";
  });

  const [userProfile, setUserProfile] = useState(() => {
    const stored = localStorage.getItem("chat_user_profile");
    return stored ? JSON.parse(stored) : null;
  });

  const [tempName, setTempName] = useState("");

  /*
  ========================================================
  🚪 HANDLE JOIN (PROFILE-AWARE)
  ========================================================
  */
  async function handleJoin() {
    if (!tempName.trim()) return;

    const user_id = tempName.trim();

    try {
      // 1. try fetch existing profile
      const { data, error } = await supabase
        .from("user_profiles")
        .select("*")
        .eq("user_id", user_id)
        .maybeSingle();

      if (error) console.error(error);

      let profile = data;

      // 2. create if not exists
      if (!profile) {
        const newUser = {
          user_id,
          display_name: tempName.trim(),
          default_language: "en",
        };

        const { data: inserted, error: insertError } = await supabase
          .from("user_profiles")
          .insert([newUser])
          .select()
          .single();

        if (insertError) {
          console.error(insertError);
          return;
        }

        profile = inserted;
      }

      // 3. persist
      localStorage.setItem("chat_username", user_id);
      localStorage.setItem("chat_user_profile", JSON.stringify(profile));

      setUsername(user_id);
      setUserProfile(profile);

    } catch (err) {
      console.error("handleJoin error:", err);
    }
  }

  // -----------------------------------------------------
  // CHAT STATE
  // -----------------------------------------------------
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const bottomRef = useRef(null);
  const scrollRef = useRef(null);

  /*
  ========================================================
  📥 LOAD MESSAGES
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    async function loadMessages() {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) return console.error(error);

      setMessages(data || []);
    }

    loadMessages();
  }, [username]);

  /*
  ========================================================
  ⚡ REALTIME
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    const channel = supabase
      .channel("messages-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === payload.new.id);
            if (exists) return prev;
            return [...prev, payload.new];
          });
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [username]);

  /*
  ========================================================
  📤 SEND MESSAGE (NOW PROFILE-AWARE)
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim() || isSending) return;

    setIsSending(true);

    try {
      const targetLanguage =
        userProfile?.default_language || "en";

      const translation = await translateMessage(
        input,
        targetLanguage
      );

      const message = {
        sender_id: username,
        original_text: input,
        translated_text: translation.translated_text,
        source_language: translation.detected_language,
        target_language: targetLanguage,
        room_id: null,
        tone: null,
      };

      const { error } = await supabase
        .from("messages")
        .insert([message]);

      if (error) console.error(error);

      setInput("");
    } finally {
      setIsSending(false);
    }
  }

  /*
  ========================================================
  📜 SCROLL
  ========================================================
  */
  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setHasNewMessages(false);
    setIsAtBottom(true);
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;

    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;

    setIsAtBottom(atBottom);

    if (atBottom) setHasNewMessages(false);
  }

  useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      setHasNewMessages(true);
    }
  }, [messages]);

  /*
  ========================================================
  🚪 LOGIN SCREEN
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
            User profiles stored in Supabase (user_profiles table)
          </div>
        </div>
      </main>
    );
  }

  /*
  ========================================================
  💬 CHAT UI
  ========================================================
  */
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md h-[80vh] bg-white border rounded flex flex-col">

        <div className="p-4 border-b font-semibold">
          Translation Chat MVP ({username})
        </div>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 space-y-3 relative"
        >
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              userId={username}
            />
          ))}

          <div ref={bottomRef} />

          {hasNewMessages && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black text-white text-xs px-3 py-1 rounded-full"
            >
              New messages ↓
            </button>
          )}
        </div>

        <div className="p-3 border-t flex gap-2">
          <input
            className="flex-1 border rounded px-3 py-2 text-sm"
            value={input}
            placeholder="Type a message..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendMessage();
              }
            }}
          />

          <button
            disabled={isSending}
            onClick={sendMessage}
            className={`px-4 rounded text-sm text-white ${
              isSending ? "bg-gray-400" : "bg-blue-500"
            }`}
          >
            {isSending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </main>
  );
}