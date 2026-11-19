import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { DragDropContext, Droppable, Draggable, type DropResult, type DroppableProvided } from '@hello-pangea/dnd'
import { io } from 'socket.io-client'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type BoardTask = {
  id: string
  title: string
  description?: string | null
  status: string
  position: number
  columnId: string
  dueAt?: string | null
  assignee?: { id: string; name: string } | null
}

type Column = {
  id: string
  name: string
  position: number
  tasks: BoardTask[]
}

type BoardDetail = {
  id: string
  name: string
  description?: string | null
  columns: Column[]
}

type WorkspaceMember = {
  id: string
  name: string
  role: string
}

export function BoardPage() {
  const { boardId } = useParams()
  const [board, setBoard] = useState<BoardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskAssigneeId, setTaskAssigneeId] = useState('')
  const [members, setMembers] = useState<WorkspaceMember[]>([])

  const fetchBoard = async () => {
    if (!boardId) return
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/api/boards/${boardId}`, { credentials: 'include' })
      if (!response.ok) {
        throw new Error('Unable to load board')
      }
      const payload = await response.json() as { board?: BoardDetail }
      setBoard(payload.board ?? null)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Board unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchBoard()
  }, [boardId])

  useEffect(() => {
    if (!boardId) return
    const socket = io(apiUrl, { transports: ['websocket'], withCredentials: true })
    socket.emit('board:join', { boardId })
    const handleBoardUpdate = () => { void fetchBoard() }
    socket.on('board:updated', handleBoardUpdate)
    return () => {
      socket.off('board:updated', handleBoardUpdate)
      socket.emit('board:leave', { boardId })
      socket.disconnect()
    }
  }, [boardId])

  useEffect(() => {
    const loadMembers = async () => {
      try {
        const response = await fetch(`${apiUrl}/api/workspace/members`, { credentials: 'include' })
        if (!response.ok) return
        const payload = await response.json() as { members?: WorkspaceMember[] }
        setMembers(payload.members ?? [])
      } catch {
        setError('Workspace members could not be loaded')
      }
    }
    void loadMembers()
  }, [])

  const createTask = async (event: FormEvent) => {
    event.preventDefault()
    if (!boardId || !taskTitle.trim() || !board) return

    const firstColumn = board.columns[0]
    if (!firstColumn) return

    try {
      const response = await fetch(`${apiUrl}/api/boards/${boardId}/tasks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: taskTitle,
          description: taskDescription,
          columnId: firstColumn.id,
          assigneeId: taskAssigneeId || null,
        }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to create task')
      }

      setTaskTitle('')
      setTaskDescription('')
      setTaskAssigneeId('')
      await fetchBoard()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to create task')
    }
  }

  const updateTaskAssignee = async (taskId: string, assigneeId: string) => {
    try {
      const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assigneeId: assigneeId || null }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to update assignee')
      }
      await fetchBoard()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to update assignee')
    }
  }

  const updateTaskPosition = async (taskId: string, sourceColumnId: string, destinationColumnId: string, destinationIndex: number) => {
    try {
      await fetch(`${apiUrl}/api/tasks/${taskId}/move`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          columnId: destinationColumnId,
          position: destinationIndex,
          sourceColumnId,
        }),
      })
    } catch {
      setError('Task move could not be saved')
    }
  }

  const onDragEnd = async (result: DropResult) => {
    if (!board || !result.destination || !result.draggableId) return

    const sourceColumn = board.columns.find((column) => column.id === result.source.droppableId)
    const destinationColumn = board.columns.find((column) => column.id === result.destination?.droppableId)
    if (!sourceColumn || !destinationColumn) return

    const sourceTasks = [...sourceColumn.tasks]
    const movingTask = sourceTasks.find((task) => task.id === result.draggableId)
    if (!movingTask) return

    const nextBoard = {
      ...board,
      columns: board.columns.map((column) => {
        if (column.id === sourceColumn.id) {
          const filtered = column.tasks.filter((task) => task.id !== result.draggableId)
          return { ...column, tasks: filtered }
        }
        if (column.id === destinationColumn.id) {
          const tasks = [...column.tasks]
          tasks.splice(result.destination!.index, 0, { ...movingTask, columnId: destinationColumn.id })
          return { ...column, tasks }
        }
        return column
      }),
    }

    setBoard(nextBoard)

    const destinationIndex = result.destination.index
    await updateTaskPosition(result.draggableId, sourceColumn.id, destinationColumn.id, destinationIndex)
    await fetchBoard()
  }

  const columns = useMemo(() => board?.columns ?? [], [board])

  if (loading) return <div className="page-panel"><div className="empty-state">Loading board…</div></div>
  if (error) return <div className="page-panel"><div className="error-state">{error}</div></div>
  if (!board) return <div className="page-panel"><div className="empty-state">Board not found.</div></div>

  return (
    <div className="page-stack">
      <div className="page-header-row">
        <div>
          <p className="eyebrow">PROJECT</p>
          <h2>{board.name}</h2>
        </div>
      </div>

      <form className="task-form" onSubmit={createTask}>
        <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Task title" />
        <input value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} placeholder="Task description" />
        <select value={taskAssigneeId} onChange={(event) => setTaskAssigneeId(event.target.value)} aria-label="Assign task to">
          <option value="">Unassigned</option>
          {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        <button type="submit" className="primary-button small">Create task</button>
      </form>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="kanban-board">
          {columns.map((column) => (
            <Droppable key={column.id} droppableId={column.id}>
              {(provided: DroppableProvided) => (
                <div className="kanban-column" ref={provided.innerRef} {...provided.droppableProps}>
                  <header className="kanban-header">
                    <h3>{column.name}</h3>
                    <span>{column.tasks.length}</span>
                  </header>

                  <div className="kanban-list">
                    {column.tasks.map((task, index) => (
                      <Draggable key={task.id} draggableId={task.id} index={index}>
                        {(dragProvided) => (
                          <article className="kanban-card" ref={dragProvided.innerRef} {...dragProvided.draggableProps} {...dragProvided.dragHandleProps}>
                            <div className="kanban-title-row">
                              <strong>{task.title}</strong>
                              <span className="task-badge">{task.status}</span>
                            </div>
                            <p>{task.description || 'No description provided.'}</p>
                            <div className="task-meta">
                              <label className="task-assignee-control">
                                <span>Assigned to</span>
                                <select
                                  value={task.assignee?.id ?? ''}
                                  onChange={(event) => { void updateTaskAssignee(task.id, event.target.value) }}
                                  onMouseDown={(event) => event.stopPropagation()}
                                  aria-label={`Assign ${task.title}`}
                                >
                                  <option value="">Unassigned</option>
                                  {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                                </select>
                              </label>
                              {task.dueAt ? <small>{new Date(task.dueAt).toLocaleDateString()}</small> : <small>No due date</small>}
                            </div>
                          </article>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>
    </div>
  )
}
