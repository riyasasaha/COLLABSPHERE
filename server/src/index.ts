import 'dotenv/config'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import express from 'express'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { Server } from 'socket.io'
import { GoogleGenAI } from '@google/genai'
import authRouter from './auth/router.js'
import { requireAuth } from './auth/middleware.js'
import { authCookieName, readCookie } from './auth/cookies.js'
import type { AuthenticatedRequest } from './auth/types.js'
import { prisma } from './prisma.js'

const app = express()
const port = Number(process.env.PORT ?? 4000)
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

const geminiApiKey = process.env.GEMINI_API_KEY
const geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const jwtSecret = process.env.JWT_SECRET ?? 'development-only-change-me'
type SessionClaims = { sub: string; email: string; name: string }
const uploadsRoot = path.resolve(process.cwd(), 'uploads')
const allowedUploadMimeTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'])
const maxUploadBytes = 25 * 1024 * 1024

mkdirSync(uploadsRoot, { recursive: true })

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes },
  fileFilter: (_request, file, callback) => {
    if (allowedUploadMimeTypes.has(file.mimetype)) {
      return callback(null, true)
    }
    return callback(new Error(`Unsupported file type: ${file.mimetype}`))
  },
})

function sanitizeFileName(name: string) {
  const base = path.basename(name || 'upload.bin').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-')
  return base || 'upload.bin'
}

function getSafeUploadPath(fileName: string) {
  const safeName = sanitizeFileName(fileName)
  const filePath = path.resolve(uploadsRoot, `${Date.now()}-${randomUUID()}-${safeName}`)
  const rootCheck = path.resolve(uploadsRoot)
  if (!filePath.startsWith(rootCheck + path.sep) && filePath !== rootCheck) {
    throw new Error('Invalid upload path')
  }
  return filePath
}

function serializeFileRecord(file: { id: string; name: string; mimeType: string; size: number; createdAt: Date; updatedAt: Date; owner: { id: string; name: string; email: string }; versions?: Array<{ id: string; name: string; mimeType: string; size: number; createdAt: Date; uploadedBy: { id: string; name: string } }> }) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    owner: file.owner,
    versions: (file.versions ?? []).map((version) => ({
      id: version.id,
      name: version.name,
      mimeType: version.mimeType,
      size: version.size,
      createdAt: version.createdAt.toISOString(),
      uploadedBy: version.uploadedBy,
    })),
  }
}

function getWorkspaceFileAccessError() {
  return { error: 'You do not have access to this workspace.' }
}

async function getWorkspaceForUser(userId: string, userName: string) {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { joinedAt: 'desc' },
  })

  if (membership) return membership.workspace

  return prisma.workspace.create({
    data: {
      name: `${userName.split(' ')[0]}'s Workspace`,
      slug: `workspace-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      ownerId: userId,
      members: { create: { userId, role: 'SUPER_ADMIN' } },
    },
  })
}

async function requireWorkspaceMembership(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  })

  if (!membership) {
    return null
  }

  return membership.role
}

const adminRoles = ['SUPER_ADMIN', 'WORKSPACE_ADMIN'] as const
const writeRoles = ['SUPER_ADMIN', 'WORKSPACE_ADMIN', 'MEMBER'] as const

function isAdminRole(role: string | null | undefined) {
  return role !== null && role !== undefined && adminRoles.includes(role as typeof adminRoles[number])
}

function isWriteRole(role: string | null | undefined) {
  return role !== null && role !== undefined && writeRoles.includes(role as typeof writeRoles[number])
}

async function requireWorkspaceAccess(userId: string, workspaceId: string, allowGuestRead = true) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  })

  if (!membership) {
    throw Object.assign(new Error('You do not have access to this workspace.'), { statusCode: 403 })
  }

  if (!allowGuestRead && membership.role === 'GUEST') {
    throw Object.assign(new Error('Guest accounts are read-only for this resource.'), { statusCode: 403 })
  }

  return membership.role
}

async function requireAuthorizedBoardAccess(userId: string, workspaceId: string, boardId: string, writeAccess = false) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  const board = await prisma.board.findFirst({
    where: { id: boardId, workspaceId },
    select: { id: true },
  })

  if (!board) {
    throw Object.assign(new Error('Board not found.'), { statusCode: 404 })
  }

  if (writeAccess && !isWriteRole(membershipRole)) {
    throw Object.assign(new Error('You do not have permission to modify this board.'), { statusCode: 403 })
  }

  return membershipRole
}

async function requireTaskWriteAccess(userId: string, workspaceId: string, taskId: string) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { id: true, assigneeId: true, creatorId: true },
  })

  if (!task) {
    throw Object.assign(new Error('Task not found.'), { statusCode: 404 })
  }

  if (!isWriteRole(membershipRole)) {
    throw Object.assign(new Error('You do not have permission to modify tasks.'), { statusCode: 403 })
  }

  return { membershipRole, task }
}

async function requireDocumentWriteAccess(userId: string, workspaceId: string, documentId: string) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId },
    select: { id: true, authorId: true },
  })

  if (!document) {
    throw Object.assign(new Error('Document not found.'), { statusCode: 404 })
  }

  if (!isWriteRole(membershipRole)) {
    throw Object.assign(new Error('You do not have permission to edit this document.'), { statusCode: 403 })
  }

  return { membershipRole, document }
}

async function requireAuditAccess(userId: string, workspaceId: string) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  if (!isAdminRole(membershipRole)) {
    throw Object.assign(new Error('Only workspace admins can access audit logs.'), { statusCode: 403 })
  }
  return membershipRole
}

async function requireMemberManagementAccess(userId: string, workspaceId: string) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  if (!isAdminRole(membershipRole)) {
    throw Object.assign(new Error('Only admins can manage workspace members.'), { statusCode: 403 })
  }
  return membershipRole
}

async function validateTaskAssignee(workspaceId: string, assigneeId: string | null | undefined) {
  const normalizedAssigneeId = assigneeId?.trim()
  if (!normalizedAssigneeId) return null

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: normalizedAssigneeId } },
    select: { userId: true },
  })

  if (!membership) {
    throw Object.assign(new Error('Assignee must be a member of this workspace.'), { statusCode: 400 })
  }

  return membership.userId
}

async function requireAnalyticsAccess(userId: string, workspaceId: string) {
  const membershipRole = await requireWorkspaceAccess(userId, workspaceId)
  if (!membershipRole) {
    throw Object.assign(new Error('You do not have access to this workspace.'), { statusCode: 403 })
  }
  return membershipRole
}

app.use(cors({ origin: process.env.CLIENT_URL ?? 'http://localhost:5173', credentials: true }))
app.use(cookieParser())
app.use(express.json())

app.use('/auth', authRouter)

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'collabsphere-api' })
})

const workspaceVideoRoom = (workspaceId: string) => `workspace:${workspaceId}:video`

function buildWorkspaceSlug(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return `${slug}-${Date.now().toString(36)}`
}

async function getOrCreateWorkspaceForUser(userId: string, userName: string) {
  const existingMembership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { joinedAt: 'desc' },
  })

  if (existingMembership) {
    return existingMembership.workspace
  }

  const workspace = await prisma.workspace.create({
    data: {
      name: `${userName.split(' ')[0]}'s Workspace`,
      slug: buildWorkspaceSlug(userName),
      ownerId: userId,
      members: {
        create: {
          userId,
          role: 'SUPER_ADMIN',
        },
      },
    },
  })

  await prisma.auditLog.create({
    data: {
      workspaceId: workspace.id,
      actorId: userId,
      action: 'workspace.created',
      entityType: 'workspace',
      entityId: workspace.id,
      metadata: JSON.parse(JSON.stringify({ name: workspace.name })),
    },
  })

  return workspace
}

function formatDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function recordAuditLog(workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  const log = await prisma.auditLog.create({
    data: {
      workspaceId,
      actorId,
      action,
      entityType,
      entityId,
      metadata: JSON.parse(JSON.stringify(metadata)),
    },
  })

  io.to(`workspace:${workspaceId}`).emit('workspace:activity', {
    workspaceId,
    action,
    entityType,
    entityId,
    createdAt: log.createdAt.toISOString(),
    actorId,
  })

  return log
}

function serializeNotificationRecord(notification: {
  id: string
  type: string
  title: string
  description: string
  entityType: string | null
  entityId: string | null
  metadata: unknown | null
  read: boolean
  createdAt: Date
  updatedAt: Date
  actor?: { id: string; name: string; avatarUrl: string | null } | null
}) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    description: notification.description,
    entityType: notification.entityType,
    entityId: notification.entityId,
    metadata: notification.metadata ?? null,
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
    actor: notification.actor ?? null,
  }
}

async function createNotification({
  workspaceId,
  recipientId,
  actorId,
  type,
  title,
  description,
  entityType,
  entityId,
  metadata,
}: {
  workspaceId: string
  recipientId: string
  actorId?: string | null
  type: string
  title: string
  description: string
  entityType?: string | null
  entityId?: string | null
  metadata?: Record<string, unknown>
}) {
  const notification = await prisma.notification.create({
    data: {
      workspaceId,
      recipientId,
      actorId: actorId ?? null,
      type,
      title,
      description,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
    },
    include: {
      actor: { select: { id: true, name: true, avatarUrl: true } },
    },
  })

  io.to(`user:${recipientId}`).emit('notifications:new', {
    notification: serializeNotificationRecord(notification),
  })

  return notification
}

function mapTaskStatusToColumn(columnName: string) {
  const normalized = columnName.toLowerCase()
  if (normalized.includes('done')) return 'DONE'
  if (normalized.includes('progress') || normalized.includes('active')) return 'IN_PROGRESS'
  return 'TODO'
}

async function getBoardDetailData(boardId: string, workspaceId: string) {
  return prisma.board.findFirst({
    where: { id: boardId, workspaceId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          tasks: {
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: {
              assignee: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  })
}

function buildWorkspacePrompt(query: string, context: Record<string, unknown>) {
  const docs = Array.isArray(context.documents) ? context.documents : []
  const tasks = Array.isArray(context.tasks) ? context.tasks : []
  const notes = Array.isArray(context.notes) ? context.notes : []

  return `You are the AI assistant for COLLABSPHERE, an enterprise collaboration workspace.

Workspace context:
- Workspace ID: ${String(context.workspaceId ?? 'unknown')}
- Focus: ${String(context.focus ?? 'general workspace support')}
- Documents:
${docs.length ? docs.map((item) => `  - ${String(item)}`).join('\n') : '  - No document summaries provided.'}
- Tasks:
${tasks.length ? tasks.map((task) => `  - ${JSON.stringify(task)}`).join('\n') : '  - No task context available.'}
- Notes:
${notes.length ? notes.map((item) => `  - ${String(item)}`).join('\n') : '  - No additional notes provided.'}

User request: ${query}

Provide a direct, useful answer tailored to a product team operating inside a collaboration workspace. When asked to summarize tasks, keep it concise. When brainstorming, offer 3-5 actionable ideas. When answering about documents, reference the provided context but do not invent facts.`
}

async function generateAssistantReply(query: string, context: Record<string, unknown>) {
  const prompt = buildWorkspacePrompt(query, context)

  if (!geminiApiKey) {
    const guidance = [
      'I’m running in demo mode because GEMINI_API_KEY is not set yet.',
      '',
      'Here’s a concise answer based on the workspace context:',
      '',
      `- For the current workspace, the most useful next step is to focus on ${String(context.focus ?? 'the current project priorities')}.`,
      `- Review the documents and tasks in this workspace to align execution before making new commitments.`,
      `- If you want deeper analysis, add your Gemini API key and the assistant can reason directly over the live workspace data.`,
    ].join('\n')

    return guidance
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey })
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: prompt,
    })

    const text = (response as { text?: string }).text ?? ''
    if (text.trim()) {
      return text.trim()
    }
  } catch (error) {
    console.error('Gemini request failed', error)
  }

  return `Here is a workspace-aware recommendation for: "${query}"

1. Prioritize the current project focus and confirm the top objective.
2. Check the most recent document context and task blockers before branching into new work.
3. Break the request into a small, measurable action plan and assign ownership.
4. Revisit the latest notes after the team meets to confirm assumptions.`
}

function chunkText(text: string, size: number) {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size))
  }
  return chunks
}

app.get('/api/dashboard', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const [boards, tasks, documents] = await Promise.all([
    prisma.board.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
    }),
    prisma.task.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { dueAt: 'asc' },
      include: { assignee: { select: { id: true, name: true } } },
    }),
    prisma.document.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, title: true, updatedAt: true },
    }),
  ])

  const activeProjects = boards.length
  const pendingTasks = tasks.filter((task) => task.status !== 'DONE').length
  const today = new Date()
  const dueToday = tasks.filter((task) => task.dueAt && task.dueAt.getTime() >= new Date(today.setHours(0, 0, 0, 0)).getTime() && task.dueAt.getTime() < new Date(today.setHours(23, 59, 59, 999)).getTime()).length
  const upcomingDeadlines = tasks.filter((task) => task.dueAt && task.dueAt.getTime() > Date.now()).length

  return response.json({
    activeProjects,
    pendingTasks,
    dueToday,
    upcomingDeadlines,
    recentDocuments: documents,
    teamActivity: tasks.slice(0, 5).map((task) => ({
      id: task.id,
      action: `${task.title} is ${task.status.toLowerCase().replace('_', ' ')}`,
      createdAt: task.updatedAt.toISOString(),
    })),
    notifications: [
      { id: 'launch', title: 'Launch momentum', description: `${pendingTasks} tasks still need ownership.` },
      { id: 'board', title: 'Portfolio health', description: `${activeProjects} active projects are in motion.` },
    ],
    workspace: { id: workspace.id, name: workspace.name },
    summary: [
      { label: 'Launch velocity', value: `${Math.min(96, 64 + activeProjects * 8)}%`, trend: '+8%' },
      { label: 'Task throughput', value: `${pendingTasks + 3}`, trend: '+12%' },
      { label: 'Team focus', value: `${Math.max(1, boards.length)}/3`, trend: 'Stable' },
    ],
  })
})

app.get('/api/boards', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  await requireWorkspaceAccess(userId, workspace.id)
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  })
  const boards = await prisma.board.findMany({
    where: { workspaceId: { in: memberships.map((membership) => membership.workspaceId) } },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { tasks: true } } },
  })

  return response.json({ boards })
})

app.post('/api/boards', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const { name, description } = request.body as { name?: string; description?: string }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return response.status(400).json({ error: 'A board name is required.' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const role = await requireWorkspaceAccess(userId, workspace.id, false)
  if (!isWriteRole(role)) {
    return response.status(403).json({ error: 'Guest accounts are read-only and cannot create boards.' })
  }

  const board = await prisma.board.create({
    data: {
      workspaceId: workspace.id,
      creatorId: userId,
      name: name.trim(),
      description: description?.trim() || null,
    },
  })

  await recordAuditLog(workspace.id, userId, 'CREATE_BOARD', 'board', board.id, { name: board.name })

  const defaultColumns = ['To do', 'In progress', 'Done']
  await prisma.column.createMany({
    data: defaultColumns.map((columnName, index) => ({
      workspaceId: workspace.id,
      boardId: board.id,
      name: columnName,
      position: index,
    })),
  })

  const createdBoard = await getBoardDetailData(board.id, workspace.id)
  return response.status(201).json({ board: createdBoard })
})

app.get('/api/boards/:boardId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const boardId = Array.isArray(request.params.boardId) ? request.params.boardId[0] : request.params.boardId
  if (!boardId) {
    return response.status(400).json({ error: 'Board id is required.' })
  }

  await requireWorkspaceAccess(userId, workspace.id)
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  })
  const board = await prisma.board.findFirst({
    where: { id: boardId, workspaceId: { in: memberships.map((membership) => membership.workspaceId) } },
    select: { workspaceId: true },
  })
  if (!board) {
    return response.status(404).json({ error: 'Board not found' })
  }

  const boardDetail = await getBoardDetailData(boardId, board.workspaceId)
  return response.json({ board: boardDetail })
})

app.post('/api/boards/:boardId/tasks', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const boardId = Array.isArray(request.params.boardId) ? request.params.boardId[0] : request.params.boardId
  if (!boardId) {
    return response.status(400).json({ error: 'Board id is required.' })
  }

  const { title, description, columnId, assigneeId } = request.body as {
    title?: string
    description?: string
    columnId?: string
    assigneeId?: string | null
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    return response.status(400).json({ error: 'Task title is required.' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    await requireWorkspaceAccess(userId, workspace.id, false)
    if (!isWriteRole(await requireWorkspaceAccess(userId, workspace.id, false))) {
      return response.status(403).json({ error: 'Guest accounts are read-only and cannot create tasks.' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  let normalizedAssigneeId: string | null = null
  try {
    normalizedAssigneeId = await validateTaskAssignee(workspace.id, assigneeId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid assignee'
    return response.status(400).json({ error: message })
  }

  try {
    await requireWorkspaceAccess(userId, workspace.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const board = await prisma.board.findFirst({
    where: { id: boardId, workspaceId: workspace.id },
  })

  if (!board) {
    return response.status(404).json({ error: 'Board not found' })
  }

  const columns = await prisma.column.findMany({
    where: { boardId: board.id, workspaceId: workspace.id },
    orderBy: { position: 'asc' },
  })

  const targetColumn = columns.find((column) => column.id === columnId) ?? columns[0]
  if (!targetColumn) {
    return response.status(400).json({ error: 'Board columns are missing.' })
  }

  const taskCount = await prisma.task.count({ where: { columnId: targetColumn.id } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      boardId: board.id,
      columnId: targetColumn.id,
      creatorId: userId,
      assigneeId: normalizedAssigneeId,
      title: title.trim(),
      description: description?.trim() || null,
      status: mapTaskStatusToColumn(targetColumn.name),
      position: taskCount,
    },
    include: {
      assignee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
    },
  })

  await recordAuditLog(workspace.id, userId, 'CREATE_TASK', 'task', task.id, {
    title: task.title,
    boardId: board.id,
    columnId: targetColumn.id,
  })

  if (task.assigneeId) {
    const assigneeLabel = task.assigneeId === userId ? 'You were assigned to' : `${task.creator.name} assigned you to`
    await createNotification({
      workspaceId: workspace.id,
      recipientId: task.assigneeId,
      actorId: userId,
      type: 'task_assigned',
      title: `Task assigned: ${task.title}`,
      description: `${assigneeLabel} “${task.title}”.`,
      entityType: 'task',
      entityId: task.id,
      metadata: { boardId: board.id, columnId: targetColumn.id },
    })
  }

  const otherMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id, userId: { not: userId } },
    select: { userId: true },
  })

  for (const member of otherMembers) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'task_created',
      title: `Task created: ${task.title}`,
      description: `${task.creator.name} created “${task.title}” in the workspace.`,
      entityType: 'task',
      entityId: task.id,
      metadata: { boardId: board.id, columnId: targetColumn.id },
    })
  }

  io.to(`board:${board.id}`).emit('board:updated', { boardId: board.id })

  return response.status(201).json({ task })
})

app.patch('/api/tasks/:taskId/move', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const taskId = Array.isArray(request.params.taskId) ? request.params.taskId[0] : request.params.taskId
  if (!taskId) {
    return response.status(400).json({ error: 'Task id is required.' })
  }

  const { columnId, position } = request.body as { columnId?: string; position?: number; sourceColumnId?: string }

  if (!columnId) {
    return response.status(400).json({ error: 'Destination column is required.' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: workspace.id },
    include: { column: true },
  })

  try {
    await requireWorkspaceAccess(userId, workspace.id, false)
    if (!isWriteRole(await requireWorkspaceAccess(userId, workspace.id, false))) {
      return response.status(403).json({ error: 'Guest accounts are read-only and cannot move tasks.' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Permission denied'
    return response.status(403).json({ error: message })
  }

  if (!task) {
    return response.status(404).json({ error: 'Task not found' })
  }

  const destinationColumn = await prisma.column.findFirst({
    where: { id: columnId, workspaceId: workspace.id },
  })

  if (!destinationColumn) {
    return response.status(404).json({ error: 'Destination column not found' })
  }

  const nextPosition = typeof position === 'number' ? Math.max(position, 0) : task.position
  const previousColumnName = task.column?.name ?? 'Unknown column'
  const updatedTask = await prisma.task.update({
    where: { id: task.id },
    data: {
      columnId: destinationColumn.id,
      position: nextPosition,
      status: mapTaskStatusToColumn(destinationColumn.name),
    },
    include: {
      assignee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
    },
  })

  await recordAuditLog(workspace.id, userId, 'MOVE_TASK', 'task', updatedTask.id, {
    fromColumnId: task.columnId,
    toColumnId: destinationColumn.id,
    position: nextPosition,
  })

  const workspaceMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    select: { userId: true },
  })

  for (const member of workspaceMembers) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'task_status_changed',
      title: `Task moved: ${updatedTask.title}`,
      description: `Task “${updatedTask.title}” moved from ${previousColumnName} to ${destinationColumn.name}.`,
      entityType: 'task',
      entityId: updatedTask.id,
      metadata: {
        fromColumn: previousColumnName,
        toColumn: destinationColumn.name,
        boardId: task.boardId,
        columnId: destinationColumn.id,
      },
    })
  }

  io.to(`board:${task.boardId}`).emit('board:updated', { boardId: task.boardId })

  return response.json({ task: updatedTask })
})

app.patch('/api/tasks/:taskId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const taskId = Array.isArray(request.params.taskId) ? request.params.taskId[0] : request.params.taskId
  if (!taskId) {
    return response.status(400).json({ error: 'Task id is required.' })
  }

  const { title, description, priority, dueAt, status, assigneeId } = request.body as {
    title?: string
    description?: string
    priority?: 'LOW' | 'MEDIUM' | 'HIGH'
    dueAt?: string | null
    status?: 'TODO' | 'IN_PROGRESS' | 'DONE'
    assigneeId?: string | null
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    const role = await requireWorkspaceAccess(userId, workspace.id, false)
    if (!isWriteRole(role)) {
      return response.status(403).json({ error: 'Guest accounts are read-only and cannot update tasks.' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: workspace.id },
  })

  if (!task) {
    return response.status(404).json({ error: 'Task not found' })
  }

  const previousAssigneeId = task.assigneeId
  let normalizedAssigneeId: string | null | undefined = undefined
  if (assigneeId !== undefined) {
    try {
      normalizedAssigneeId = await validateTaskAssignee(workspace.id, assigneeId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid assignee'
      return response.status(400).json({ error: message })
    }
  }

  const updatedTask = await prisma.task.update({
    where: { id: task.id },
    data: {
      ...(title !== undefined && { title: title.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(priority !== undefined && { priority }),
      ...(dueAt !== undefined && { dueAt: dueAt ? new Date(dueAt) : null }),
      ...(status !== undefined && { status }),
      ...(assigneeId !== undefined && { assigneeId: normalizedAssigneeId }),
    },
    include: {
      assignee: { select: { id: true, name: true } },
      creator: { select: { id: true, name: true } },
    },
  })

  await recordAuditLog(workspace.id, userId, 'UPDATE_TASK', 'task', updatedTask.id, {
    title: updatedTask.title,
    status: updatedTask.status,
    assigneeId: updatedTask.assigneeId,
  })

  if (normalizedAssigneeId && normalizedAssigneeId !== previousAssigneeId) {
    const assigneeLabel = normalizedAssigneeId === userId ? 'You were assigned to' : `${updatedTask.creator.name} assigned you to`
    await createNotification({
      workspaceId: workspace.id,
      recipientId: normalizedAssigneeId,
      actorId: userId,
      type: 'task_assigned',
      title: `Task assigned: ${updatedTask.title}`,
      description: `${assigneeLabel} “${updatedTask.title}”.`,
      entityType: 'task',
      entityId: updatedTask.id,
      metadata: { boardId: task.boardId },
    })
  }

  if (status !== undefined || dueAt !== undefined || title !== undefined || description !== undefined) {
    const previousStatusName = task.status
    const nextStatusName = status ?? task.status
    const recipients = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      select: { userId: true },
    })

    for (const recipient of recipients) {
      const isStatusChange = status !== undefined && previousStatusName !== nextStatusName
      await createNotification({
        workspaceId: workspace.id,
        recipientId: recipient.userId,
        actorId: userId,
        type: isStatusChange ? 'task_status_changed' : 'task_updated',
        title: isStatusChange ? `Task status: ${updatedTask.title}` : `Task updated: ${updatedTask.title}`,
        description: isStatusChange
          ? `Task “${updatedTask.title}” moved from ${previousStatusName.replace('_', ' ').toLowerCase()} to ${nextStatusName.replace('_', ' ').toLowerCase()}.`
          : `${updatedTask.creator.name} updated “${updatedTask.title}”.`,
        entityType: 'task',
        entityId: updatedTask.id,
        metadata: {
          status: updatedTask.status,
          fromStatus: previousStatusName,
          toStatus: nextStatusName,
          dueAt: updatedTask.dueAt?.toISOString() ?? null,
        },
      })
    }
  }

  io.to(`board:${task.boardId}`).emit('board:updated', { boardId: task.boardId })

  return response.json({ task: updatedTask })
})

app.delete('/api/tasks/:taskId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) {
    return response.status(401).json({ error: 'Authentication required' })
  }

  const taskId = Array.isArray(request.params.taskId) ? request.params.taskId[0] : request.params.taskId
  if (!taskId) {
    return response.status(400).json({ error: 'Task id is required.' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    const role = await requireWorkspaceAccess(userId, workspace.id, false)
    if (!isWriteRole(role)) {
      return response.status(403).json({ error: 'Guest accounts are read-only and cannot delete tasks.' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: workspace.id },
  })

  if (!task) {
    return response.status(404).json({ error: 'Task not found' })
  }

  await prisma.task.delete({
    where: { id: task.id },
  })

  await recordAuditLog(workspace.id, userId, 'DELETE_TASK', 'task', task.id, { title: task.title, boardId: task.boardId })

  io.to(`board:${task.boardId}`).emit('board:updated', { boardId: task.boardId })

  return response.status(204).end()
})

app.get('/api/workspace/members', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    include: {
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  })

  return response.json({
    members: members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      avatarUrl: m.user.avatarUrl,
    })),
  })
})

app.get('/api/workspace/permissions', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    await requireMemberManagementAccess(userId, workspace.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const actorMembership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    select: { role: true },
  })

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    orderBy: { joinedAt: 'asc' },
  })

  return response.json({
    currentUserRole: actorMembership?.role ?? 'MEMBER',
    canManageRoles: actorMembership?.role === 'SUPER_ADMIN' || actorMembership?.role === 'WORKSPACE_ADMIN',
    members: members.map((member) => ({
      id: member.id,
      userId: member.user.id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      avatarUrl: member.user.avatarUrl,
      joinedAt: member.joinedAt.toISOString(),
    })),
  })
})

app.patch('/api/workspace/members/:memberId/role', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const memberId = Array.isArray(request.params.memberId) ? request.params.memberId[0] : request.params.memberId
  const { role } = request.body as { role?: 'SUPER_ADMIN' | 'WORKSPACE_ADMIN' | 'MEMBER' | 'GUEST' }

  if (!memberId) return response.status(400).json({ error: 'Member id is required' })
  if (!role) return response.status(400).json({ error: 'Role is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const actorMembership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    select: { role: true },
  })

  if (!actorMembership || !isAdminRole(actorMembership.role)) {
    return response.status(403).json({ error: 'Only admins can manage workspace roles' })
  }

  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId: workspace.id },
    include: { user: { select: { id: true, name: true, email: true } } },
  })

  if (!member) return response.status(404).json({ error: 'Workspace member not found' })

  const updatedMember = await prisma.workspaceMember.update({
    where: { id: member.id },
    data: { role },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  })

  await recordAuditLog(workspace.id, userId, 'ROLE_CHANGE', 'workspace_member', member.userId, {
    userId: member.userId,
    targetRole: role,
    actorEmail: request.user?.email,
  })

  return response.json({
    member: {
      id: updatedMember.id,
      userId: updatedMember.user.id,
      name: updatedMember.user.name,
      email: updatedMember.user.email,
      role: updatedMember.role,
      avatarUrl: updatedMember.user.avatarUrl,
    },
  })
})

app.post('/api/workspace/members', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const { email, role } = request.body as { email?: string; role?: 'MEMBER' | 'GUEST' }
  const normalizedEmail = email?.trim().toLowerCase()
  if (!normalizedEmail) return response.status(400).json({ error: 'Email is required' })
  if (role !== 'MEMBER' && role !== 'GUEST') {
    return response.status(400).json({ error: 'Role must be MEMBER or GUEST' })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    await requireMemberManagementAccess(userId, workspace.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const targetUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, name: true, email: true, avatarUrl: true },
  })
  if (!targetUser) return response.status(404).json({ error: 'User not found. They must register first.' })

  const existingMembership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: targetUser.id } },
  })
  if (existingMembership) return response.status(409).json({ error: 'User is already a member of this workspace.' })

  const member = await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: targetUser.id, role },
  })

  await recordAuditLog(workspace.id, userId, 'MEMBER_ADD', 'workspace_member', targetUser.id, {
    userId: targetUser.id,
    targetRole: role,
    actorEmail: request.user?.email,
  })

  return response.status(201).json({
    member: {
      id: member.id,
      userId: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: member.role,
      avatarUrl: targetUser.avatarUrl,
      joinedAt: member.joinedAt.toISOString(),
    },
  })
})

app.get('/api/chat', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const channel = String(request.query.channel ?? 'general')
  const messages = await prisma.message.findMany({
    where: { workspaceId: workspace.id, channel },
    orderBy: { createdAt: 'asc' },
    include: { sender: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    take: 200,
  })

  return response.json({
    channel,
    messages: messages.map((message) => ({
      id: message.id,
      channel: message.channel,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      sender: {
        id: message.sender.id,
        name: message.sender.name,
        email: message.sender.email,
        avatarUrl: message.sender.avatarUrl,
      },
    })),
  })
})

app.post('/api/chat', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const { channel, body } = request.body as { channel?: string; body?: string }
  const normalizedChannel = (channel ?? 'general').trim() || 'general'
  const trimmedBody = (body ?? '').trim()

  if (!trimmedBody) return response.status(400).json({ error: 'Message content is required.' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const message = await prisma.message.create({
    data: {
      workspaceId: workspace.id,
      senderId: userId,
      channel: normalizedChannel,
      body: trimmedBody,
    },
    include: { sender: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  })

  const payload = {
    id: message.id,
    channel: message.channel,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      email: message.sender.email,
      avatarUrl: message.sender.avatarUrl,
    },
  }

  io.to(`chat:${workspace.id}:${normalizedChannel}`).emit('chat:new_message', payload)

  const mentions = Array.from(new Set(trimmedBody.match(/@([A-Za-z0-9_]+)/g) ?? [])).map((mention) => mention.slice(1).toLowerCase())
  if (mentions.length > 0) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: { select: { id: true, name: true } } },
    })

    for (const member of members) {
      const normalizedName = member.user.name.toLowerCase().replace(/\s+/g, '')
      if (mentions.includes(normalizedName) && member.userId !== userId) {
        await createNotification({
          workspaceId: workspace.id,
          recipientId: member.userId,
          actorId: userId,
          type: 'mention',
          title: `Mentioned in ${normalizedChannel}`,
          description: `${message.sender.name} mentioned you in #${normalizedChannel}.`,
          entityType: 'message',
          entityId: message.id,
          metadata: { channel: normalizedChannel },
        })
      }
    }
  }

  const otherMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id, userId: { not: userId } },
    select: { userId: true },
  })

  for (const member of otherMembers) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'chat_message',
      title: `New message in #${normalizedChannel}`,
      description: `${message.sender.name}: ${trimmedBody.slice(0, 96)}${trimmedBody.length > 96 ? '…' : ''}`,
      entityType: 'message',
      entityId: message.id,
      metadata: { channel: normalizedChannel },
    })
  }

  await recordAuditLog(workspace.id, userId, 'chat.message_created', 'message', message.id, { channel: normalizedChannel })

  return response.status(201).json({ message: payload })
})

app.get('/api/files', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const requestedWorkspaceId = Array.isArray(request.query.workspaceId) ? request.query.workspaceId[0] : request.query.workspaceId
  const workspace = requestedWorkspaceId
    ? await prisma.workspace.findFirst({ where: { id: requestedWorkspaceId }, include: { members: { where: { userId } } } })
    : await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')

  if (!workspace) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    select: { id: true },
  })

  if (!membership) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const activeWorkspaceId = workspace.id
  const files = await prisma.file.findMany({
    where: { workspaceId: activeWorkspaceId },
    orderBy: { updatedAt: 'desc' },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      versions: { orderBy: { createdAt: 'desc' }, take: 10, include: { uploadedBy: { select: { id: true, name: true } } } },
    },
  })

  return response.json({ files: files.map((file) => serializeFileRecord({ ...file, owner: file.owner, versions: file.versions })) })
})

app.post('/api/files', requireAuth, upload.single('file'), async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  if (!request.file) {
    return response.status(400).json({ error: 'A file upload is required.' })
  }

  try {
    const workspace = await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
    const role = await requireWorkspaceAccess(userId, workspace.id, false)
    if (!isWriteRole(role)) {
      return response.status(403).json({ error: 'Guest accounts are read-only and cannot upload files.' })
    }

    const rawMimeType = request.file.mimetype || 'application/octet-stream'
    const allowedByMime = allowedUploadMimeTypes.has(rawMimeType)
    if (!allowedByMime || request.file.size > maxUploadBytes) {
      return response.status(400).json({ error: 'File type or size is not allowed.' })
    }

    const safeName = sanitizeFileName(request.body.name || request.file.originalname || 'upload.bin')
    const storagePath = getSafeUploadPath(safeName)
    const buffer = request.file.buffer
    const checksum = createHash('sha256').update(buffer).digest('hex')

    mkdirSync(path.dirname(storagePath), { recursive: true })
    writeFileSync(storagePath, buffer)

    const file = await prisma.file.create({
      data: {
        workspaceId: workspace.id,
        ownerId: userId,
        name: safeName,
        mimeType: rawMimeType,
        size: buffer.length,
        storagePath: path.relative(process.cwd(), storagePath),
        checksum,
      },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' }, take: 10, include: { uploadedBy: { select: { id: true, name: true } } } },
      },
    })

    const version = await prisma.fileVersion.create({
      data: {
        fileId: file.id,
        workspaceId: workspace.id,
        uploadedById: userId,
        name: safeName,
        mimeType: rawMimeType,
        size: buffer.length,
        storagePath: path.relative(process.cwd(), storagePath),
        checksum,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    })

    await recordAuditLog(workspace.id, userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, versionId: version.id })

    const workspaceMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id, userId: { not: userId } },
      select: { userId: true },
    })

    for (const member of workspaceMembers) {
      await createNotification({
        workspaceId: workspace.id,
        recipientId: member.userId,
        actorId: userId,
        type: 'file_uploaded',
        title: `File uploaded: ${file.name}`,
        description: `${request.user?.name ?? 'Someone'} uploaded “${file.name}”.`,
        entityType: 'file',
        entityId: file.id,
        metadata: { name: file.name, size: file.size },
      })
    }

    const serializedFile = serializeFileRecord({ ...file, owner: file.owner, versions: [version] })
    io.to(`workspace:${workspace.id}`).emit('file:created', { file: serializedFile })

    return response.status(201).json({ file: serializedFile })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to upload file.'
    return response.status(400).json({ error: message })
  }
})

app.get('/api/files/:fileId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const fileId = Array.isArray(request.params.fileId) ? request.params.fileId[0] : request.params.fileId
  const workspaceId = Array.isArray(request.query.workspaceId) ? request.query.workspaceId[0] : request.query.workspaceId

  const workspace = workspaceId
    ? await prisma.workspace.findFirst({ where: { id: workspaceId } })
    : await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')

  if (!workspace) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    select: { id: true },
  })

  if (!membership) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId: workspace.id },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      versions: { orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { id: true, name: true } } } },
    },
  })

  if (!file) return response.status(404).json({ error: 'File not found.' })

  return response.json({ file: serializeFileRecord({ ...file, owner: file.owner, versions: file.versions }) })
})

app.get('/api/files/:fileId/download', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const fileId = Array.isArray(request.params.fileId) ? request.params.fileId[0] : request.params.fileId
  const workspaceId = Array.isArray(request.query.workspaceId) ? request.query.workspaceId[0] : request.query.workspaceId

  const workspace = workspaceId
    ? await prisma.workspace.findFirst({ where: { id: workspaceId } })
    : await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')

  if (!workspace) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    select: { id: true },
  })

  if (!membership) {
    return response.status(403).json(getWorkspaceFileAccessError())
  }

  const file = await prisma.file.findFirst({ where: { id: fileId, workspaceId: workspace.id } })
  if (!file) return response.status(404).json({ error: 'File not found.' })

  const absolutePath = path.resolve(process.cwd(), file.storagePath)
  const root = path.resolve(process.cwd(), 'uploads')
  if (!absolutePath.startsWith(root) || !statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    return response.status(404).json({ error: 'Stored file missing.' })
  }

  const contents = readFileSync(absolutePath)
  response.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
  response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
  response.setHeader('Content-Length', String(contents.length))
  return response.send(contents)
})

app.get('/api/files/:fileId/versions', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const fileId = Array.isArray(request.params.fileId) ? request.params.fileId[0] : request.params.fileId
  const workspace = await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const file = await prisma.file.findFirst({ where: { id: fileId, workspaceId: workspace.id } })
  if (!file) return response.status(404).json({ error: 'File not found.' })

  const versions = await prisma.fileVersion.findMany({
    where: { fileId: file.id, workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    include: { uploadedBy: { select: { id: true, name: true } } },
  })

  return response.json({ versions: versions.map((version) => ({
    id: version.id,
    name: version.name,
    mimeType: version.mimeType,
    size: version.size,
    createdAt: version.createdAt.toISOString(),
    uploadedBy: version.uploadedBy,
  })) })
})

app.delete('/api/files/:fileId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const fileId = Array.isArray(request.params.fileId) ? request.params.fileId[0] : request.params.fileId
  const workspace = await getWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const file = await prisma.file.findFirst({ where: { id: fileId, workspaceId: workspace.id }, include: { owner: true } })
  if (!file) return response.status(404).json({ error: 'File not found.' })

  const membership = await requireWorkspaceMembership(userId, workspace.id)
  const canDelete = file.ownerId === userId || membership === 'SUPER_ADMIN' || membership === 'WORKSPACE_ADMIN'
  if (!canDelete) return response.status(403).json({ error: 'You do not have permission to delete this file.' })
  if (membership === 'GUEST') return response.status(403).json({ error: 'Guest accounts are read-only and cannot delete files.' })

  const versionRecords = await prisma.fileVersion.findMany({ where: { fileId: file.id } })
  for (const version of versionRecords) {
    try {
      const absolutePath = path.resolve(process.cwd(), version.storagePath)
      const root = path.resolve(process.cwd(), 'uploads')
      if (absolutePath.startsWith(root)) {
        unlinkSync(absolutePath)
      }
    } catch {
      // ignore missing file cleanup
    }
  }

  try {
    const absolutePath = path.resolve(process.cwd(), file.storagePath)
    const root = path.resolve(process.cwd(), 'uploads')
    if (absolutePath.startsWith(root)) {
      unlinkSync(absolutePath)
    }
  } catch {
    // ignore missing file cleanup
  }

  await prisma.fileVersion.deleteMany({ where: { fileId: file.id } })
  await prisma.file.delete({ where: { id: file.id } })
  await recordAuditLog(workspace.id, userId, 'DELETE_FILE', 'file', file.id, { name: file.name })

  const fileMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id, userId: { not: userId } },
    select: { userId: true },
  })

  for (const member of fileMembers) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'file_deleted',
      title: `File deleted: ${file.name}`,
      description: `${request.user?.name ?? 'A teammate'} deleted “${file.name}”.`,
      entityType: 'file',
      entityId: file.id,
      metadata: { name: file.name },
    })
  }

  io.to(`workspace:${workspace.id}`).emit('file:deleted', { fileId: file.id, workspaceId: workspace.id })

  return response.status(204).end()
})

app.get('/api/notifications', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const notifications = await prisma.notification.findMany({
    where: { workspaceId: workspace.id, recipientId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
  })

  return response.json({
    notifications: notifications.map((notification) => serializeNotificationRecord({
      ...notification,
      metadata: notification.metadata as Record<string, unknown> | null,
      actor: notification.actor,
    })),
  })
})

app.patch('/api/notifications/:notificationId/read', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const notificationId = Array.isArray(request.params.notificationId) ? request.params.notificationId[0] : request.params.notificationId
  if (!notificationId) return response.status(400).json({ error: 'Notification id is required.' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const existingNotification = await prisma.notification.findFirst({
    where: { id: notificationId, workspaceId: workspace.id, recipientId: userId },
    include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
  })

  if (!existingNotification) return response.status(404).json({ error: 'Notification not found' })

  const notification = await prisma.notification.update({
    where: { id: existingNotification.id },
    data: { read: true },
    include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
  })

  io.to(`user:${userId}`).emit('notifications:updated', {
    notification: serializeNotificationRecord({
      ...notification,
      metadata: notification.metadata as Record<string, unknown> | null,
      actor: notification.actor,
    }),
  })

  return response.json({ notification: serializeNotificationRecord({
    ...notification,
    metadata: notification.metadata as Record<string, unknown> | null,
    actor: notification.actor,
  }) })
})

app.patch('/api/notifications/read-all', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const notifications = await prisma.notification.updateMany({
    where: { workspaceId: workspace.id, recipientId: userId, read: false },
    data: { read: true },
  })

  io.to(`user:${userId}`).emit('notifications:updated', {
    allRead: true,
    count: notifications.count,
  })

  return response.json({ updated: notifications.count })
})

app.get('/api/search', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const query = String(request.query.q ?? '').trim()
  if (!query) {
    return response.json({
      query: '',
      total: 0,
      results: {
        tasks: [],
        documents: [],
        users: [],
        messages: [],
        files: [],
      },
    })
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')

  const [tasks, documents, users, messages, files] = await Promise.all([
    prisma.task.findMany({
      where: { workspaceId: workspace.id, OR: [{ title: { contains: query, mode: 'insensitive' } }, { description: { contains: query, mode: 'insensitive' } }] },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      include: { board: { select: { id: true, name: true } } },
    }),
    prisma.document.findMany({
      where: { workspaceId: workspace.id, OR: [{ title: { contains: query, mode: 'insensitive' } }, { content: { contains: query, mode: 'insensitive' } }] },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { id: true, title: true, content: true, updatedAt: true },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id, OR: [{ user: { name: { contains: query, mode: 'insensitive' } } }, { user: { email: { contains: query, mode: 'insensitive' } } }] },
      orderBy: { joinedAt: 'asc' },
      take: 8,
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    }),
    prisma.message.findMany({
      where: { workspaceId: workspace.id, OR: [{ body: { contains: query, mode: 'insensitive' } }, { sender: { name: { contains: query, mode: 'insensitive' } } }] },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { sender: { select: { id: true, name: true } } },
    }),
    prisma.file.findMany({
      where: { workspaceId: workspace.id, OR: [{ name: { contains: query, mode: 'insensitive' } }, { mimeType: { contains: query, mode: 'insensitive' } }] },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { id: true, name: true, mimeType: true, size: true, updatedAt: true },
    }),
  ])

  const results = {
    tasks: tasks.map((task) => ({
      id: task.id,
      type: 'task',
      title: task.title,
      summary: task.description ?? 'Task update',
      updatedAt: task.updatedAt.toISOString(),
      route: `/projects/${task.boardId}`,
    })),
    documents: documents.map((document) => ({
      id: document.id,
      type: 'document',
      title: document.title,
      summary: document.content.replace(/<[^>]*>/g, ' ').slice(0, 160) || 'No preview available',
      updatedAt: document.updatedAt.toISOString(),
      route: `/documents/${document.id}`,
    })),
    users: users.map((member) => ({
      id: member.user.id,
      type: 'user',
      title: member.user.name,
      summary: member.user.email,
      updatedAt: member.joinedAt.toISOString(),
      route: '/settings',
    })),
    messages: messages.map((message) => ({
      id: message.id,
      type: 'message',
      title: `Message from ${message.sender.name}`,
      summary: message.body.slice(0, 160),
      updatedAt: message.createdAt.toISOString(),
      route: '/chat',
    })),
    files: files.map((file) => ({
      id: file.id,
      type: 'file',
      title: file.name,
      summary: `${file.mimeType} • ${file.size} bytes`,
      updatedAt: file.updatedAt.toISOString(),
      route: '/files',
    })),
  }

  const total = Object.values(results).reduce((sum, group) => sum + group.length, 0)

  return response.json({ query, total, results })
})

app.get('/api/analytics', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    await requireAnalyticsAccess(userId, workspace.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const [projectCount, taskCount, documentCount, memberCount, fileCount, recentActivity, taskStatusCounts] = await Promise.all([
    prisma.board.count({ where: { workspaceId: workspace.id } }),
    prisma.task.count({ where: { workspaceId: workspace.id } }),
    prisma.document.count({ where: { workspaceId: workspace.id } }),
    prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    prisma.file.count({ where: { workspaceId: workspace.id } }),
    prisma.auditLog.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { actor: { select: { id: true, name: true } } },
    }),
    prisma.task.groupBy({
      by: ['status'],
      where: { workspaceId: workspace.id },
      _count: { _all: true },
    }),
  ])

  const statusSummary = {
    TODO: taskStatusCounts.find((item) => item.status === 'TODO')?._count._all ?? 0,
    IN_PROGRESS: taskStatusCounts.find((item) => item.status === 'IN_PROGRESS')?._count._all ?? 0,
    DONE: taskStatusCounts.find((item) => item.status === 'DONE')?._count._all ?? 0,
  }

  const completedTasks = statusSummary.DONE
  const pendingTasks = Math.max(taskCount - completedTasks, 0)
  const completionRate = taskCount === 0 ? 0 : Number(((completedTasks / taskCount) * 100).toFixed(1))

  const activityWindowStart = new Date(Date.now() - 1000 * 60 * 60 * 24 * 6)
  const activityTrail = await prisma.auditLog.findMany({
    where: {
      workspaceId: workspace.id,
      createdAt: { gte: activityWindowStart },
    },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const countsByDay = new Map<string, number>()
  for (const entry of activityTrail) {
    const key = formatDateKey(new Date(entry.createdAt))
    countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1)
  }

  const activityChart = Array.from({ length: 7 }, (_, index) => {
    const day = new Date()
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - (6 - index))
    const key = formatDateKey(day)
    const value = countsByDay.get(key) ?? 0

    return {
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value,
    }
  })

  const chartSummary = [
    { label: 'To do', value: statusSummary.TODO, color: 'var(--accent-amber)' },
    { label: 'In progress', value: statusSummary.IN_PROGRESS, color: 'var(--accent-cyan)' },
    { label: 'Done', value: statusSummary.DONE, color: 'var(--accent-emerald)' },
  ]

  return response.json({
    workspace: { id: workspace.id, name: workspace.name },
    metrics: {
      projectCount,
      taskCount,
      completedTasks,
      pendingTasks,
      completionRate,
      activeUsers: memberCount,
      documentCount,
      fileCount,
    },
    statusSummary,
    activity: recentActivity.map((entry: { id: string; action: string; actor?: { name: string } | null; createdAt: Date; entityType: string; entityId: string }) => ({
      id: entry.id,
      action: entry.action,
      actor: entry.actor?.name ?? 'System',
      entityType: entry.entityType,
      entityId: entry.entityId,
      createdAt: entry.createdAt.toISOString(),
    })),
    chart: {
      status: chartSummary,
      activity: activityChart,
    },
  })
})

app.get('/api/audit', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  try {
    await requireAuditAccess(userId, workspace.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Access denied'
    return response.status(403).json({ error: message })
  }

  const auditLogs = await prisma.auditLog.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { id: true, name: true, email: true } } },
  })

  return response.json({
    logs: auditLogs.map((entry) => ({
      id: entry.id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      createdAt: entry.createdAt.toISOString(),
      actor: entry.actor ? { id: entry.actor.id, name: entry.actor.name, email: entry.actor.email } : null,
      metadata: entry.metadata,
    })),
  })
})

app.get('/api/documents', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const documents = await prisma.document.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { versions: true, comments: true } },
    },
  })

  return response.json({ documents })
})

app.post('/api/documents', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const { title, content } = request.body as { title?: string; content?: string }
  const docTitle = title?.trim() || 'Untitled document'
  const initialContent = content || `<h1>${docTitle}</h1><p>Start collaborating on this document in real-time...</p>`

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const role = await requireWorkspaceAccess(userId, workspace.id, false)
  if (!isWriteRole(role)) {
    return response.status(403).json({ error: 'Guest accounts are read-only and cannot create documents.' })
  }

  const document = await prisma.document.create({
    data: {
      workspaceId: workspace.id,
      authorId: userId,
      title: docTitle,
      content: initialContent,
      versions: {
        create: {
          workspaceId: workspace.id,
          authorId: userId,
          version: 1,
          content: initialContent,
        },
      },
    },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      _count: { select: { versions: true, comments: true } },
    },
  })

  await recordAuditLog(workspace.id, userId, 'CREATE_DOCUMENT', 'document', document.id, {
    title: document.title,
  })

  const documentMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id, userId: { not: userId } },
    select: { userId: true },
  })

  for (const member of documentMembers) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'document_created',
      title: `Document created: ${document.title}`,
      description: `${request.user?.name ?? 'A teammate'} created “${document.title}”.`,
      entityType: 'document',
      entityId: document.id,
      metadata: { title: document.title },
    })
  }

  return response.status(201).json({ document })
})

app.get('/api/documents/:documentId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId: workspace.id },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      versions: {
        orderBy: { version: 'desc' },
        include: { author: { select: { id: true, name: true } } },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, avatarUrl: true } } },
      },
      _count: { select: { versions: true, comments: true } },
    },
  })

  if (!document) return response.status(404).json({ error: 'Document not found' })

  return response.json({ document })
})

app.patch('/api/documents/:documentId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const { title, content, createVersionSnapshot } = request.body as {
    title?: string
    content?: string
    createVersionSnapshot?: boolean
  }

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const accessRole = await requireWorkspaceAccess(userId, workspace.id, false)
  if (!isWriteRole(accessRole)) {
    return response.status(403).json({ error: 'Guest accounts are read-only and cannot edit documents.' })
  }

  const existing = await prisma.document.findFirst({
    where: { id: documentId, workspaceId: workspace.id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })

  if (!existing) return response.status(404).json({ error: 'Document not found' })

  const nextTitle = title !== undefined ? title.trim() || 'Untitled document' : existing.title
  const nextContent = content !== undefined ? content : existing.content

  if (createVersionSnapshot && content !== undefined) {
    const latestVersion = existing.versions[0]?.version ?? 0
    await prisma.documentVersion.create({
      data: {
        workspaceId: workspace.id,
        documentId: existing.id,
        authorId: userId,
        version: latestVersion + 1,
        content: nextContent,
      },
    })
  }

  const updatedDocument = await prisma.document.update({
    where: { id: existing.id },
    data: {
      title: nextTitle,
      content: nextContent,
    },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      versions: {
        orderBy: { version: 'desc' },
        include: { author: { select: { id: true, name: true } } },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, avatarUrl: true } } },
      },
      _count: { select: { versions: true, comments: true } },
    },
  })

  await recordAuditLog(workspace.id, userId, 'UPDATE_DOCUMENT', 'document', updatedDocument.id, {
    title: updatedDocument.title,
    changedTitle: nextTitle !== existing.title,
  })

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id, userId: { not: userId } },
    select: { userId: true },
  })

  for (const member of members) {
    await createNotification({
      workspaceId: workspace.id,
      recipientId: member.userId,
      actorId: userId,
      type: 'document_updated',
      title: `Document updated: ${updatedDocument.title}`,
      description: `${request.user?.name ?? 'A teammate'} updated “${updatedDocument.title}”.`,
      entityType: 'document',
      entityId: updatedDocument.id,
      metadata: { title: updatedDocument.title },
    })
  }

  io.to(`doc:${existing.id}`).emit('doc:meta_updated', {
    documentId: existing.id,
    title: updatedDocument.title,
    updatedAt: updatedDocument.updatedAt.toISOString(),
  })

  return response.json({ document: updatedDocument })
})

app.delete('/api/documents/:documentId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const accessRole = await requireWorkspaceAccess(userId, workspace.id, false)
  if (!isWriteRole(accessRole)) {
    return response.status(403).json({ error: 'Guest accounts are read-only and cannot delete documents.' })
  }

  const existing = await prisma.document.findFirst({
    where: { id: documentId, workspaceId: workspace.id },
  })

  if (!existing) return response.status(404).json({ error: 'Document not found' })

  await prisma.document.delete({ where: { id: existing.id } })

  io.to(`doc:${existing.id}`).emit('doc:deleted', { documentId: existing.id })

  return response.status(204).end()
})

app.get('/api/documents/:documentId/versions', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const versions = await prisma.documentVersion.findMany({
    where: { documentId, workspaceId: workspace.id },
    orderBy: { version: 'desc' },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  })

  return response.json({ versions })
})

app.post('/api/documents/:documentId/versions', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId: workspace.id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })

  if (!document) return response.status(404).json({ error: 'Document not found' })

  const latestVersion = document.versions[0]?.version ?? 0
  const createdVersion = await prisma.documentVersion.create({
    data: {
      workspaceId: workspace.id,
      documentId: document.id,
      authorId: userId,
      version: latestVersion + 1,
      content: document.content,
    },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  })

  io.to(`doc:${document.id}`).emit('doc:version_created', { version: createdVersion })

  return response.status(201).json({ version: createdVersion })
})

app.post('/api/documents/:documentId/restore/:versionId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  const versionId = Array.isArray(request.params.versionId) ? request.params.versionId[0] : request.params.versionId

  if (!documentId || !versionId) return response.status(400).json({ error: 'Document id and version id are required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const targetVersion = await prisma.documentVersion.findFirst({
    where: { id: versionId, documentId, workspaceId: workspace.id },
  })

  if (!targetVersion) return response.status(404).json({ error: 'Version snapshot not found' })

  const latestVersionRecord = await prisma.documentVersion.findFirst({
    where: { documentId, workspaceId: workspace.id },
    orderBy: { version: 'desc' },
  })

  const nextVersionNumber = (latestVersionRecord?.version ?? 0) + 1

  // Create new version snapshot preserving rollback history
  await prisma.documentVersion.create({
    data: {
      workspaceId: workspace.id,
      documentId,
      authorId: userId,
      version: nextVersionNumber,
      content: targetVersion.content,
    },
  })

  const updatedDocument = await prisma.document.update({
    where: { id: documentId },
    data: { content: targetVersion.content },
    include: {
      author: { select: { id: true, name: true, avatarUrl: true } },
      versions: {
        orderBy: { version: 'desc' },
        include: { author: { select: { id: true, name: true } } },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, avatarUrl: true } } },
      },
      _count: { select: { versions: true, comments: true } },
    },
  })

  io.to(`doc:${documentId}`).emit('doc:restored', {
    documentId,
    content: targetVersion.content,
    version: nextVersionNumber,
  })

  return response.json({ document: updatedDocument, restoredVersion: nextVersionNumber })
})

app.post('/api/documents/:documentId/comments', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const documentId = Array.isArray(request.params.documentId) ? request.params.documentId[0] : request.params.documentId
  if (!documentId) return response.status(400).json({ error: 'Document id is required' })

  const { content } = request.body as { content?: string }
  if (!content || !content.trim()) return response.status(400).json({ error: 'Comment content is required' })

  const workspace = await getOrCreateWorkspaceForUser(userId, request.user?.name ?? 'Workspace')
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId: workspace.id },
  })

  if (!document) return response.status(404).json({ error: 'Document not found' })

  const comment = await prisma.comment.create({
    data: {
      workspaceId: workspace.id,
      documentId: document.id,
      authorId: userId,
      content: content.trim(),
    },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
  })

  io.to(`doc:${document.id}`).emit('doc:comment_added', { comment })

  return response.status(201).json({ comment })
})

app.delete('/api/documents/:documentId/comments/:commentId', requireAuth, async (request: AuthenticatedRequest, response) => {
  const userId = request.user?.id
  if (!userId) return response.status(401).json({ error: 'Authentication required' })

  const commentId = Array.isArray(request.params.commentId) ? request.params.commentId[0] : request.params.commentId
  if (!commentId) return response.status(400).json({ error: 'Comment id is required' })

  const comment = await prisma.comment.findFirst({
    where: { id: commentId },
  })

  if (!comment) return response.status(404).json({ error: 'Comment not found' })
  if (comment.authorId !== userId) {
    return response.status(403).json({ error: 'You can only delete your own comments' })
  }

  await prisma.comment.delete({ where: { id: commentId } })

  io.to(`doc:${comment.documentId}`).emit('doc:comment_deleted', { commentId })

  return response.status(204).end()
})

app.post('/api/assistant/chat', async (request, response) => {
  const { workspaceId, query, context } = request.body as {
    workspaceId?: string
    query?: string
    context?: Record<string, unknown>
  }

  if (!query || typeof query !== 'string') {
    return response.status(400).json({ error: 'A valid user query is required.' })
  }

  const resolvedContext = {
    workspaceId: workspaceId ?? 'workspace-demo-01',
    focus: 'Launch operations',
    ...(context ?? {}),
  }

  const reply = await generateAssistantReply(query, resolvedContext)
  const acceptHeader = request.get('accept') ?? ''

  if (acceptHeader.includes('text/event-stream')) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')

    const chunks = chunkText(reply, 32)
    chunks.forEach((chunk, index) => {
      response.write(`event: message\ndata: ${JSON.stringify({ content: chunk, index, total: chunks.length })}\n\n`)
    })

    response.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
    response.end()
    return
  }

  return response.json({
    workspaceId: resolvedContext.workspaceId,
    response: reply,
    model: geminiModel,
    provider: geminiApiKey ? 'gemini' : 'demo',
  })
})

const docPresenceRooms = new Map<string, Map<string, { socketId: string; userId: string; name: string; color: string; cursor?: { from: number; to: number } }>>()

io.use((socket, next) => {
  const token = readCookie(socket.handshake, authCookieName)
  if (!token) return next(new Error('Authentication required'))

  try {
    const claims = jwt.verify(token, jwtSecret) as SessionClaims
    socket.data.userId = claims.sub
    socket.data.userName = claims.name
    return next()
  } catch {
    return next(new Error('Invalid or expired session'))
  }
})

io.on('connection', (socket) => {
  socket.on('board:join', async ({ boardId }: { boardId?: string }) => {
    if (!boardId) return
    const board = await prisma.board.findUnique({ where: { id: boardId }, select: { workspaceId: true } })
    if (board && await requireWorkspaceMembership(socket.data.userId as string, board.workspaceId)) {
      socket.join(`board:${boardId}`)
    }
  })

  socket.on('board:leave', ({ boardId }: { boardId?: string }) => {
    if (boardId) {
      socket.leave(`board:${boardId}`)
    }
  })

  socket.on('doc:join', async ({ documentId, user }: { documentId?: string; user?: { id: string; name: string; color?: string } }) => {
    if (!documentId) return
    const document = await prisma.document.findUnique({ where: { id: documentId }, select: { workspaceId: true } })
    if (!document || !await requireWorkspaceMembership(socket.data.userId as string, document.workspaceId)) return
    const room = `doc:${documentId}`
    socket.join(room)

    if (!docPresenceRooms.has(documentId)) {
      docPresenceRooms.set(documentId, new Map())
    }

    const roomPresences = docPresenceRooms.get(documentId)!
    const userColor = user?.color || ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'][Math.floor(Math.random() * 6)]

    roomPresences.set(socket.id, {
      socketId: socket.id,
      userId: socket.data.userId as string,
      name: socket.data.userName as string,
      color: userColor,
    })

    io.to(room).emit('doc:presence_update', {
      documentId,
      users: Array.from(roomPresences.values()),
    })
  })

  socket.on('doc:leave', ({ documentId }: { documentId?: string }) => {
    if (!documentId) return
    const room = `doc:${documentId}`
    socket.leave(room)

    const roomPresences = docPresenceRooms.get(documentId)
    if (roomPresences) {
      roomPresences.delete(socket.id)
      io.to(room).emit('doc:presence_update', {
        documentId,
        users: Array.from(roomPresences.values()),
      })
    }
  })

  socket.on('doc:update', ({ documentId, content, update }: { documentId?: string; content?: string; update?: unknown }) => {
    if (!documentId || !socket.rooms.has(`doc:${documentId}`)) return
    socket.to(`doc:${documentId}`).emit('doc:update', {
      documentId,
      content,
      update,
      senderId: socket.id,
    })
  })

  socket.on('doc:cursor', ({ documentId, cursor }: { documentId?: string; cursor?: { from: number; to: number } }) => {
    if (!documentId || !socket.rooms.has(`doc:${documentId}`)) return
    const roomPresences = docPresenceRooms.get(documentId)
    if (roomPresences && roomPresences.has(socket.id)) {
      const current = roomPresences.get(socket.id)!
      current.cursor = cursor
    }

    socket.to(`doc:${documentId}`).emit('doc:cursor', {
      peerId: socket.id,
      cursor,
      user: { id: socket.data.userId as string, name: socket.data.userName as string },
    })
  })

  socket.on('doc:typing', ({ documentId, isTyping }: { documentId?: string; isTyping?: boolean }) => {
    if (!documentId || !socket.rooms.has(`doc:${documentId}`)) return
    socket.to(`doc:${documentId}`).emit('doc:typing', {
      peerId: socket.id,
      user: { id: socket.data.userId as string, name: socket.data.userName as string },
      isTyping,
    })
  })

  socket.on('workspace:join', async ({ workspaceId }: { workspaceId?: string }) => {
    if (!workspaceId) return
    if (await requireWorkspaceMembership(socket.data.userId as string, workspaceId)) {
      socket.join(`workspace:${workspaceId}`)
    }
  })

  socket.on('workspace:leave', ({ workspaceId }: { workspaceId?: string }) => {
    if (!workspaceId) return
    socket.leave(`workspace:${workspaceId}`)
  })

  socket.on('user:join', ({ userId }: { userId?: string }) => {
    if (userId && userId === socket.data.userId) {
      socket.join(`user:${socket.data.userId}`)
    }
  })

  socket.on('user:leave', ({ userId }: { userId?: string }) => {
    if (!userId) return
    socket.leave(`user:${userId}`)
  })

  socket.on('chat:join', async ({ workspaceId, channel }: { workspaceId?: string; channel?: string }) => {
    if (!workspaceId) return
    if (!await requireWorkspaceMembership(socket.data.userId as string, workspaceId)) return
    const room = `chat:${workspaceId}:${channel ?? 'general'}`
    socket.join(room)
  })

  socket.on('chat:leave', ({ workspaceId, channel }: { workspaceId?: string; channel?: string }) => {
    if (!workspaceId) return
    socket.leave(`chat:${workspaceId}:${channel ?? 'general'}`)
  })

  socket.on('chat:typing', ({ workspaceId, channel, user, isTyping }: { workspaceId?: string; channel?: string; user?: { id?: string; name?: string }; isTyping?: boolean }) => {
    if (!workspaceId || !channel || !socket.rooms.has(`chat:${workspaceId}:${channel}`)) return
    socket.to(`chat:${workspaceId}:${channel}`).emit('chat:typing', {
      channel,
      user: { id: socket.data.userId as string, name: socket.data.userName as string },
      isTyping,
    })
  })

  socket.on('video:join', async ({ workspaceId }: { workspaceId?: string }) => {
    if (!workspaceId) return
    if (!await requireWorkspaceMembership(socket.data.userId as string, workspaceId)) return

    const room = workspaceVideoRoom(workspaceId)
    socket.data.workspaceId = workspaceId
    socket.join(room)

    const peers = Array.from(io.sockets.adapter.rooms.get(room)?.values() ?? []).filter((peerId) => peerId !== socket.id)
    socket.emit('video:room_state', {
      peers: peers.map((peerId) => ({ peerId, userId: io.sockets.sockets.get(peerId)?.data?.userId ?? peerId })),
    })

    socket.to(room).emit('video:peer_joined', {
      peerId: socket.id,
      userId: socket.data.userId,
    })
  })

  socket.on('video:leave', ({ workspaceId }: { workspaceId?: string }) => {
    if (!workspaceId || socket.data.workspaceId !== workspaceId) return

    const room = workspaceVideoRoom(workspaceId)
    socket.leave(room)
    socket.to(room).emit('video:peer_left', { peerId: socket.id })
  })

  socket.on('video:offer', ({ workspaceId, targetId, offer }: { workspaceId?: string; targetId?: string; offer?: RTCSessionDescriptionInit }) => {
    if (!workspaceId || socket.data.workspaceId !== workspaceId || !targetId || !offer) return
    if (!io.sockets.sockets.get(targetId)?.rooms.has(workspaceVideoRoom(workspaceId))) return
    io.to(targetId).emit('video:offer', {
      peerId: socket.id,
      offer,
    })
  })

  socket.on('video:answer', ({ workspaceId, targetId, answer }: { workspaceId?: string; targetId?: string; answer?: RTCSessionDescriptionInit }) => {
    if (!workspaceId || socket.data.workspaceId !== workspaceId || !targetId || !answer) return
    if (!io.sockets.sockets.get(targetId)?.rooms.has(workspaceVideoRoom(workspaceId))) return
    io.to(targetId).emit('video:answer', {
      peerId: socket.id,
      answer,
    })
  })

  socket.on('video:ice-candidate', ({ workspaceId, targetId, candidate }: { workspaceId?: string; targetId?: string; candidate?: RTCIceCandidateInit }) => {
    if (!workspaceId || socket.data.workspaceId !== workspaceId || !targetId || !candidate) return
    if (!io.sockets.sockets.get(targetId)?.rooms.has(workspaceVideoRoom(workspaceId))) return
    io.to(targetId).emit('video:ice-candidate', {
      peerId: socket.id,
      candidate,
    })
  })

  socket.on('disconnect', () => {
    const workspaceId = socket.data.workspaceId as string | undefined
    if (workspaceId) {
      socket.to(workspaceVideoRoom(workspaceId)).emit('video:peer_left', {
        peerId: socket.id,
      })
    }

    docPresenceRooms.forEach((roomPresences, documentId) => {
      if (roomPresences.has(socket.id)) {
        roomPresences.delete(socket.id)
        io.to(`doc:${documentId}`).emit('doc:presence_update', {
          documentId,
          users: Array.from(roomPresences.values()),
        })
      }
    })
  })
})

httpServer.listen(port, () => {
  console.log(`Collabsphere API listening on http://localhost:${port}`)
})
