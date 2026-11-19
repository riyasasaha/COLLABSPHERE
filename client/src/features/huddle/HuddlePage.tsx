import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type Participant = {
  id: string
  name: string
  stream: MediaStream
  isLocal?: boolean
}

type PeerEntry = {
  connection: RTCPeerConnection
  stream: MediaStream
  name: string
}

export function HuddlePage() {
  const navigate = useNavigate()
  const [workspaceId, setWorkspaceId] = useState('')
  const workspaceIdRef = useRef('')
  const localUserRef = useRef<{ id: string; name: string } | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peerConnectionsRef = useRef<Map<string, PeerEntry>>(new Map())
  const leftHuddleRef = useRef(false)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [status, setStatus] = useState('Connecting to call room…')

  const updateParticipants = (nextMap: Map<string, PeerEntry>) => {
    const list: Participant[] = []

    if (localStreamRef.current) {
      list.push({ id: 'local', name: localUserRef.current?.name ?? 'You', stream: localStreamRef.current, isLocal: true })
    }

    nextMap.forEach((peer, id) => {
      list.push({ id, name: peer.name, stream: peer.stream })
    })

    setParticipants(list)
  }

  const createPeerConnection = (peerId: string, peerName: string) => {
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing) return existing.connection

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    const stream = localStreamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))
    }

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams
      if (!remoteStream) return

      const nextPeers = new Map(peerConnectionsRef.current)
      const existingPeer = nextPeers.get(peerId)
      if (existingPeer) {
        existingPeer.stream = remoteStream
      } else {
        nextPeers.set(peerId, { connection: pc, stream: remoteStream, name: peerName })
      }
      peerConnectionsRef.current = nextPeers
      updateParticipants(nextPeers)
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current) return
      socketRef.current.emit('video:ice-candidate', {
        workspaceId: workspaceIdRef.current,
        targetId: peerId,
        candidate: event.candidate.toJSON(),
      })
    }

    peerConnectionsRef.current.set(peerId, { connection: pc, stream: new MediaStream(), name: peerName })
    return pc
  }

  const startCall = async () => {
    if (leftHuddleRef.current) return

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: true,
    })

    if (leftHuddleRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    localStreamRef.current = stream
    setParticipants([{ id: 'local', name: localUserRef.current?.name ?? 'You', stream, isLocal: true }])
    setStatus('Call room connected / ready to share')

    socketRef.current?.emit('video:join', { workspaceId: workspaceIdRef.current, userId: localUserRef.current?.id })
  }

  const leaveHuddle = (navigateAway = true) => {
    if (leftHuddleRef.current) return
    leftHuddleRef.current = true

    const socket = socketRef.current
    if (socket) {
      socket.emit('video:leave', { workspaceId })
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }

    peerConnectionsRef.current.forEach((peer) => {
      peer.connection.ontrack = null
      peer.connection.onicecandidate = null
      peer.connection.close()
    })
    peerConnectionsRef.current.clear()

    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setParticipants([])
    setStatus('You left the huddle')

    if (navigateAway) navigate('/')
  }

  useEffect(() => {
    let cancelled = false
    leftHuddleRef.current = false
    setParticipants([])
    setAudioEnabled(true)
    setVideoEnabled(true)
    setStatus('Connecting to call room…')

    async function init() {
      try {
        const [sessionResponse, workspaceResponse] = await Promise.all([
          fetch(`${apiUrl}/auth/me`, { credentials: 'include' }),
          fetch(`${apiUrl}/api/dashboard`, { credentials: 'include' }),
        ])
        if (!sessionResponse.ok || !workspaceResponse.ok) throw new Error('Workspace access is unavailable')
        const sessionPayload = await sessionResponse.json() as { user?: { id: string; name: string } }
        const workspacePayload = await workspaceResponse.json() as { workspace?: { id: string } }
        if (!sessionPayload.user?.id || !workspacePayload.workspace?.id) throw new Error('Workspace access is unavailable')
        setWorkspaceId(workspacePayload.workspace.id)
        localUserRef.current = sessionPayload.user
        workspaceIdRef.current = workspacePayload.workspace.id

        const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
        socketRef.current = socket

        socket.on('connect', () => {
          if (!cancelled && !leftHuddleRef.current) {
            void startCall()
          }
        })

        socket.on('video:room_state', ({ peers }: { peers: Array<{ peerId: string; userId: string }> }) => {
          peers.forEach(({ peerId, userId }) => {
            if (peerId === socket.id) return
            const pc = createPeerConnection(peerId, userId)
            void pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
              socket.emit('video:offer', {
                workspaceId: workspaceIdRef.current,
                targetId: peerId,
                offer: pc.localDescription,
              })
            })
          })
        })

        socket.on('video:peer_joined', ({ peerId, userId }: { peerId: string; userId: string }) => {
          if (peerId === socket.id) return
          const pc = createPeerConnection(peerId, userId)
          void pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
            socket.emit('video:offer', {
                workspaceId: workspaceIdRef.current,
              targetId: peerId,
              offer: pc.localDescription,
            })
          })
        })

        socket.on('video:offer', async ({ peerId, offer }: { peerId: string; offer: RTCSessionDescriptionInit }) => {
          const pc = createPeerConnection(peerId, peerId)
          await pc.setRemoteDescription(new RTCSessionDescription(offer))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          socket.emit('video:answer', {
            workspaceId: workspaceIdRef.current,
            targetId: peerId,
            answer: pc.localDescription,
          })
        })

        socket.on('video:answer', async ({ peerId, answer }: { peerId: string; answer: RTCSessionDescriptionInit }) => {
          const peer = peerConnectionsRef.current.get(peerId)
          if (!peer) return
          await peer.connection.setRemoteDescription(new RTCSessionDescription(answer))
        })

        socket.on('video:ice-candidate', async ({ peerId, candidate }: { peerId: string; candidate: RTCIceCandidateInit }) => {
          const peer = peerConnectionsRef.current.get(peerId)
          if (!peer) return
          await peer.connection.addIceCandidate(new RTCIceCandidate(candidate))
        })

        socket.on('video:peer_left', ({ peerId }: { peerId: string }) => {
          const peer = peerConnectionsRef.current.get(peerId)
          if (peer) {
            peer.connection.close()
            peerConnectionsRef.current.delete(peerId)
          }
          updateParticipants(new Map(peerConnectionsRef.current))
        })
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Camera access was blocked')
      }
    }

    void init()

    return () => {
      cancelled = true
      leaveHuddle(false)
    }
  }, [])

  const toggleAudio = () => {
    if (!localStreamRef.current) return
    const next = !audioEnabled
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = next
    })
    setAudioEnabled(next)
  }

  const toggleVideo = () => {
    if (!localStreamRef.current) return
    const next = !videoEnabled
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = next
    })
    setVideoEnabled(next)
  }

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">HUDDLE</p>
          <h2>Workspace huddle</h2>
        </div>
      </div>

      <div className="video-shell page-video-shell">
        <div className="video-noise" />
        <div className="status-strip">
          <span className="pulse" />
          {status}
        </div>

        <section className="stats-row">
          <article>
            <span>Participants</span>
            <strong>{participants.length}</strong>
          </article>
          <article>
            <span>Audio</span>
            <strong>{audioEnabled ? 'Live' : 'Muted'}</strong>
          </article>
          <article>
            <span>Video</span>
            <strong>{videoEnabled ? 'On' : 'Off'}</strong>
          </article>
        </section>

        <section className="video-grid">
          {participants.map((participant) => (
            <article key={participant.id} className="video-tile">
              <video
                ref={(node) => {
                  if (node && participant.stream) {
                    node.srcObject = participant.stream
                    node.muted = participant.isLocal ?? false
                    node.play().catch(() => undefined)
                  }
                }}
                autoPlay
                playsInline
                muted={participant.isLocal ?? false}
              />
              <div className="video-footer">
                <span>{participant.name}</span>
                <span>{participant.isLocal ? 'You' : 'Live'}</span>
              </div>
            </article>
          ))}
        </section>

        <div className="control-bar">
          <button type="button" className={`control-button ${audioEnabled ? '' : 'off'}`} onClick={toggleAudio}>
            {audioEnabled ? 'Mute' : 'Unmute'}
          </button>
          <button type="button" className={`control-button ${videoEnabled ? '' : 'off'}`} onClick={toggleVideo}>
            {videoEnabled ? 'Stop video' : 'Start video'}
          </button>
          <button type="button" className="control-button leave-button" onClick={() => leaveHuddle()}>
            Leave Huddle
          </button>
        </div>
      </div>
    </div>
  )
}
