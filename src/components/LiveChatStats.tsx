import { useChatStats } from '../hooks/useChatStats';
import { Video, MessageSquare, Radio } from 'lucide-react';

export function LiveChatStats({ currentMode }: { currentMode?: 'video' | 'text' }) {
  const { stats, loading } = useChatStats();

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-xs text-ink-faint animate-pulse py-2">
        <Radio className="h-3.5 w-3.5 animate-spin text-accent" />
        <span>Loading live network status...</span>
      </div>
    );
  }

  // Render text helper based on the mode
  const renderStatRow = (mode: 'video' | 'text', label: string, icon: React.ReactNode) => {
    const modeStat = stats[mode];
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-bg-muted/40 p-3 text-left">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
          {icon}
        </span>
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">{label} Mode</span>
          <p className="text-sm text-ink-muted mt-0.5">
            <span className="font-bold text-ink">{modeStat.online}</span> are online,{' '}
            <span className="font-bold text-accent">{modeStat.chatting}</span> of them are chatting.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="w-full space-y-2 mt-2">
      {/* If currentMode is passed, only show that specific mode stats; otherwise show both */}
      {(!currentMode || currentMode === 'video') && 
        renderStatRow('video', 'Video', <Video className="h-4 w-4" />)
      }
      {(!currentMode || currentMode === 'text') && 
        renderStatRow('text', 'Text Chat', <MessageSquare className="h-4 w-4" />)
      }
    </div>
  );
}