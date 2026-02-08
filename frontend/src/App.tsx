import { useMemo, useState } from 'react';
import './App.css';

type Role = 'user' | 'assistant';

type Message = {
  id: string;
  role: Role;
  content: string;
  timestamp: string;
};

const mockReplies = [
  'Got it. I can help with that. Want a quick outline or detailed steps?',
  'Here is a short response to test the UI. I can expand once the backend is ready.',
  'Message received. I will reply with a concise summary and next steps.',
  'I am a mocked reply. Swap to live mode later to connect the real agent.',
];

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const nowStamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const replyIndex = useMemo(() => messages.length % mockReplies.length, [messages.length]);

  const addMessage = (role: Role, content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: createId(), role, content, timestamp: nowStamp() },
    ]);
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) {
      return;
    }

    setIsRunning(true);
    addMessage('user', trimmed);
    setInput('');

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      addMessage('assistant', mockReplies[replyIndex]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addMessage('assistant', `Message failed: ${message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">AudioTool Sample UI</p>
          <h1>ChatUITemplate1</h1>
          <p className="subtitle">Enter a message and get a mocked reply.</p>
          <p className="subtitle">This is a temporary UI for testing purposes.</p>
        </div>
        <button type="button" className="ghost" onClick={handleReset}>
          Clear chat
        </button>
      </header>

      <main className="chat-card">
        <div className="messages">
          {messages.length === 0 ? (
            <div className="empty">
              <p>Start the conversation by sending a message.</p>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                <div className="message-meta">
                  <span className="role">{message.role}</span>
                  <span className="time">{message.timestamp}</span>
                </div>
                <p>{message.content}</p>
              </div>
            ))
          )}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            handleSend();
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type your message..."
            aria-label="Chat message"
          />
          <button type="submit" disabled={!input.trim() || isRunning}>
            {isRunning ? 'Sending...' : 'Send'}
          </button>
        </form>
      </main>
    </div>
  );
}
