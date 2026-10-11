/**
 * Custom JSX runtime for pi-tui components.
 *
 * Intrinsic elements:
 *   <text>     → Text component
 *   <box>      → Box component (container with background)
 *   <container>→ Container component
 *   <spacer>   → Spacer component
 *
 * Component functions receive props and return a Component.
 * Fragments are flattened into the parent container.
 */
import { Text, Box, Container, Spacer, type Component } from '@earendil-works/pi-tui'

type Props = Record<string, any> & { children?: any }

function flattenChildren(children: any): Component[] {
  const result: Component[] = []
  const arr = Array.isArray(children) ? children : [children]
  for (const child of arr) {
    if (child == null || child === false) continue
    if (typeof child === 'string' || typeof child === 'number') {
      result.push(new Text(String(child)))
    } else if (child instanceof Container || child instanceof Box || child instanceof Text || child instanceof Spacer) {
      result.push(child)
    } else if (typeof child === 'object' && child !== null && 'render' in child && typeof child.render === 'function') {
      result.push(child as Component)
    }
  }
  return result
}

function addChildrenTo(target: { addChild(c: Component): void }, children: any): void {
  for (const child of flattenChildren(children)) {
    target.addChild(child)
  }
}

function createIntrinsic(type: string, props: Props): Component {
  const { children, ...rest } = props

  switch (type) {
    case 'text': {
      const textContent = children != null ? String(children) : (rest.text ?? '')
      return new Text(textContent, rest.paddingX ?? 0, rest.paddingY ?? 0, rest.bgFn)
    }
    case 'box': {
      const box = new Box(rest.paddingX ?? 0, rest.paddingY ?? 0, rest.bgFn)
      addChildrenTo(box, children)
      return box
    }
    case 'spacer': {
      return new Spacer(rest.lines ?? 1)
    }
    case 'container': {
      const container = new Container()
      addChildrenTo(container, children)
      return container
    }
    default:
      throw new Error(`Unknown JSX element type: ${type}`)
  }
}

/**
 * Classic JSX factory: h(type, props, ...children)
 * Used with tsconfig: jsxFactory = "h"
 */
export function h(type: string | ((props: any) => Component), props: any, ...children: any[]): Component {
  const mergedProps = { ...(props ?? {}), children: children.length === 1 ? children[0] : children }

  if (typeof type === 'function') {
    return type(mergedProps)
  }

  return createIntrinsic(type, mergedProps)
}

/**
 * Fragment component for grouping children without a wrapper.
 */
export function Fragment(_props: any): Component {
  // Fragment is handled by h() via the children merging above.
  // This export exists for the jsxFragmentFactory config.
  return new Container()
}

// Re-export for automatic transform compatibility
export { h as jsx, h as jsxs }
