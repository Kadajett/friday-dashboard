import { VoiceCall } from '@/components/VoiceCall'
import {
  type DashboardData,
  renderDashboardComponent,
} from '@/components/dashboard/component-registry'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIsMobile } from '@/hooks/use-mobile'
import type { DashboardConfig } from '@/shared/dashboard-schema'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SendHorizontal, SignalHigh, SignalLow, SignalMedium } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const Route = createFileRoute('/')({ component: App })

type Payload = {
  config: DashboardConfig
  data: DashboardData
}

type NetworkHealth = {
  latencyMs: number | null
  quality: 'secure' | 'connecting' | 'degraded'
}

async function fetchDashboard(): Promise<Payload> {
  const res = await fetch('/api/dashboard-config')
  if (!res.ok) throw new Error('Failed to load dashboard payload')
  return res.json()
}

function DashboardContent({ config, data }: { config: DashboardConfig; data: DashboardData }) {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <section>
        <h1 className="text-2xl font-bold md:text-3xl tracking-tight">{config.app.title}</h1>
        <p className="text-muted-foreground">{config.app.subtitle}</p>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {config.components.map((component) => renderDashboardComponent(component, data))}
      </section>
    </div>
  )
}

function ChatPane({
  data,
  history,
  onTranscript,
}: {
  data: DashboardData
  history: DashboardData['chat']['history']
  onTranscript: (entry: DashboardData['chat']['history'][number]) => void
}) {
  const [draft, setDraft] = useState('')
  const [networkHealth, setNetworkHealth] = useState<NetworkHealth>({
    latencyMs: null,
    quality: 'connecting',
  })

  const networkColor = useMemo(() => {
    if (networkHealth.quality === 'secure') return 'bg-[#1f6feb] text-white border-[#4fa3ff]'
    if (networkHealth.quality === 'connecting') return 'bg-[#0ea5e9] text-white border-[#7dd3fc]'
    return 'bg-[#ef4444] text-white border-[#fca5a5]'
  }, [networkHealth.quality])

  async function submitTextMessage() {
    const message = draft.trim()
    if (!message) return
    setDraft('')

    try {
      const userEntry = {
        role: 'user' as const,
        message,
        timestamp: new Date().toISOString(),
      }
      onTranscript(userEntry)

      const chatRes = await fetch('/api/webrtc/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'friday-default-room', role: 'user', message }),
      })
      if (!chatRes.ok) {
        onTranscript({
          role: 'system',
          message: `Message log failed (${chatRes.status}).`,
          timestamp: new Date().toISOString(),
        })
        return
      }

      const response = await fetch('/api/webrtc/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'friday-default-room', transcript: message }),
      })
      if (!response.ok) {
        onTranscript({
          role: 'system',
          message: `Assistant request failed (${response.status}).`,
          timestamp: new Date().toISOString(),
        })
        return
      }

      const payload = (await response.json()) as {
        reply: DashboardData['chat']['history'][number]
        audioBase64?: string | null
        audioMimeType?: string | null
      }
      onTranscript(payload.reply)

      if (payload.audioBase64) {
        const audio = new Audio(
          `data:${payload.audioMimeType || 'audio/ogg; codecs=opus'};base64,${payload.audioBase64}`,
        )
        await audio.play().catch((err) => {
          console.error('ChatPane audio playback failed', err)
        })
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Chat request failed due to a network error.'
      onTranscript({
        role: 'system',
        message,
        timestamp: new Date().toISOString(),
      })
    }
  }

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-[#0b1220] to-[#0d1527] text-slate-100">
      <div className="flex items-center justify-between border-b border-white/10 p-4 md:px-6">
        <h2 className="text-xl font-bold tracking-tight">Friday Chat Stream</h2>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              data.chat.status === 'thinking'
                ? 'bg-amber-400 animate-pulse'
                : data.chat.status === 'processing'
                  ? 'bg-sky-400 animate-pulse'
                  : 'bg-emerald-400'
            }`}
          />
          <span className="text-slate-300">{data.chat.statusText}</span>
          <Badge className={networkColor}>
            {networkHealth.quality === 'secure' ? (
              <SignalHigh className="mr-1 h-3.5 w-3.5" />
            ) : null}
            {networkHealth.quality === 'connecting' ? (
              <SignalMedium className="mr-1 h-3.5 w-3.5" />
            ) : null}
            {networkHealth.quality === 'degraded' ? (
              <SignalLow className="mr-1 h-3.5 w-3.5" />
            ) : null}
            {networkHealth.latencyMs ? `${networkHealth.latencyMs}ms` : 'probing'}
          </Badge>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 px-4 py-4 md:px-6 scrollbar-hide">
        {history.map((entry, idx) => (
          <div
            key={`${entry.timestamp}-${idx}`}
            className={`max-w-[85%] rounded-2xl p-3 shadow-sm ${
              entry.role === 'user'
                ? 'ml-auto bg-[#1f6feb] text-white rounded-tr-none'
                : 'bg-white/8 text-slate-100 border border-white/10 rounded-tl-none'
            }`}
          >
            <div className="mb-1 flex items-center justify-between text-[10px] opacity-70 uppercase tracking-widest font-black">
              <span>{entry.role}</span>
              <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </div>
            <p className="text-sm leading-relaxed">{entry.message}</p>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 space-y-3 border-t border-white/10 bg-[#0b1220]/95 p-3 backdrop-blur md:p-4">
        <VoiceCall onTranscript={onTranscript} onNetworkChange={setNetworkHealth} />
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitTextMessage()
              }
            }}
            placeholder="Send Friday a command..."
            className="bg-[#0f1b31] border-white/15 text-slate-100 placeholder:text-slate-400"
          />
          <Button
            onClick={() => {
              void submitTextMessage()
            }}
            className="bg-[#1f6feb] hover:bg-[#1a5fd1]"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function App() {
  const isMobile = useIsMobile()
  const [chatHistory, setChatHistory] = useState<DashboardData['chat']['history']>([])
  const chatHistorySeeded = useRef(false)

  const query = useQuery({
    queryKey: ['dashboard-payload'],
    queryFn: fetchDashboard,
    refetchInterval: (q) => q.state.data?.config.app.refreshIntervalMs ?? 5000,
  })

  const onTranscript = useCallback((entry: DashboardData['chat']['history'][number]) => {
    setChatHistory((current) => [...current, entry].slice(-120))
  }, [])

  useEffect(() => {
    if (chatHistorySeeded.current) return
    if (query.data?.data.chat.history) {
      chatHistorySeeded.current = true
      setChatHistory(query.data.data.chat.history)
    }
  }, [query.data?.data.chat.history])

  if (query.isLoading || !query.data) {
    return (
      <div className="p-8 text-sm text-muted-foreground animate-pulse font-mono tracking-tighter">
        INITIALIZING_FRIDAY_SYSTEMS...
      </div>
    )
  }

  const { config, data } = query.data

  if (isMobile) {
    return (
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        <Tabs defaultValue="chat" className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <TabsContent
              forceMount
              value="dashboard"
              className="m-0 border-0 h-full overflow-y-auto data-[state=inactive]:hidden"
            >
              <DashboardContent config={config} data={data} />
            </TabsContent>
            <TabsContent
              forceMount
              value="chat"
              className="m-0 border-0 h-full overflow-hidden data-[state=inactive]:hidden"
            >
              <ChatPane data={data} history={chatHistory} onTranscript={onTranscript} />
            </TabsContent>
          </div>
          <TabsList className="grid w-full grid-cols-2 rounded-none h-16 border-t bg-card/70 backdrop-blur-md">
            <TabsTrigger value="dashboard" className="data-[state=active]:bg-muted/50 h-full">
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="chat" className="data-[state=active]:bg-muted/50 h-full relative">
              Chat
              <span
                className={`ml-2 h-2 w-2 rounded-full ${
                  data.chat.status === 'thinking'
                    ? 'bg-amber-500'
                    : data.chat.status === 'processing'
                      ? 'bg-sky-500'
                      : 'bg-emerald-500'
                }`}
              />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background overflow-hidden">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize={62} minSize={30}>
          <div className="h-full overflow-y-auto scrollbar-hide bg-muted/10">
            <DashboardContent config={config} data={data} />
          </div>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          className="w-1 bg-border/50 hover:bg-primary/20 transition-colors"
        />
        <ResizablePanel defaultSize={38} minSize={24}>
          <ChatPane data={data} history={chatHistory} onTranscript={onTranscript} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
