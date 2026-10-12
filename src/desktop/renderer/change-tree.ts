import type { DesktopReviewChange } from '../protocol.ts'

export interface ReviewFileNode {
  readonly kind: 'file'
  readonly name: string
  readonly path: string
  readonly change: DesktopReviewChange
}

export interface ReviewDirectoryNode {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: readonly ReviewTreeNode[]
}

export type ReviewTreeNode = ReviewFileNode | ReviewDirectoryNode

interface MutableDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: Map<string, MutableDirectory | ReviewFileNode>
}

function compareNodes(left: ReviewTreeNode, right: ReviewTreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    || left.name.localeCompare(right.name)
}

function freezeChildren(nodes: Iterable<MutableDirectory | ReviewFileNode>): readonly ReviewTreeNode[] {
  return Object.freeze([...nodes].map((node): ReviewTreeNode => {
    if (node.kind === 'file') return node
    return Object.freeze({
      kind: 'directory',
      name: node.name,
      path: node.path,
      children: freezeChildren(node.children.values()).toSorted(compareNodes),
    })
  }).toSorted(compareNodes))
}

/** Groups Git's repository-relative changed paths into a stable directory tree. */
export function buildReviewChangeTree(changes: readonly DesktopReviewChange[]): readonly ReviewTreeNode[] {
  const root: MutableDirectory = { kind: 'directory', name: '', path: '', children: new Map() }

  for (const change of changes) {
    const parts = change.path.replaceAll('\\', '/').split('/').filter(Boolean)
    if (parts.length === 0) continue

    let parent = root
    let directoryPath = ''
    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part
      let directory = parent.children.get(part)
      if (!directory || directory.kind !== 'directory') {
        directory = { kind: 'directory', name: part, path: directoryPath, children: new Map() }
        parent.children.set(part, directory)
      }
      parent = directory
    }

    const name = parts.at(-1)!
    parent.children.set(name, Object.freeze({ kind: 'file', name, path: parts.join('/'), change }))
  }

  return freezeChildren(root.children.values())
}

/** Keeps matching files and their ancestor folders visible in the review tree. */
export function filterReviewChangeTree(nodes: readonly ReviewTreeNode[], query: string): readonly ReviewTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return nodes

  return Object.freeze(nodes.flatMap((node): ReviewTreeNode[] => {
    if (node.kind === 'file') {
      return node.path.toLocaleLowerCase().includes(normalized) ? [node] : []
    }

    if (node.name.toLocaleLowerCase().includes(normalized)) return [node]
    const children = filterReviewChangeTree(node.children, normalized)
    return children.length > 0 ? [Object.freeze({ ...node, children })] : []
  }))
}
