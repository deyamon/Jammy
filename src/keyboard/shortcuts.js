function isEditableTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName?.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  return Boolean(target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-shortcut-ignore]'))
}

function isInteractiveTarget(target) {
  const tagName = target?.tagName?.toLowerCase()
  if (['button', 'a', 'summary', 'select'].includes(tagName)) return true
  return Boolean(target?.closest?.('button, a, summary, [role="button"], [role="link"], [role="slider"], [role="tab"], [role="menuitem"], input[type="range"]'))
}

export function attachKeyboardShortcuts(target, getActions) {
  const handleKeydown = (event) => {
    const actions = getActions?.() ?? {}
    const hasCommandModifier = event.ctrlKey || event.metaKey
    const hasOtherModifier = event.altKey

    if (event.key === 'Escape' && !hasCommandModifier && !hasOtherModifier && typeof actions.escape === 'function') {
      event.preventDefault()
      actions.escape()
      return
    }

    if (hasOtherModifier) return
    if (hasCommandModifier) {
      if (event.key.toLowerCase() === 'k' && typeof actions.focusSearch === 'function') {
        event.preventDefault()
        actions.focusSearch()
      }
      return
    }
    if (isEditableTarget(event.target) || isInteractiveTarget(event.target)) return
    if (event.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return

    const key = event.key.toLowerCase()
    let action
    if (event.key === ' ' || event.code === 'Space') action = actions.togglePlay
    else if (event.shiftKey && key === 'n') action = actions.next
    else if (event.shiftKey && key === 'p') action = actions.previous
    else if (!event.shiftKey && key === 'r') action = actions.cycleRepeat
    else if (!event.shiftKey && key === 'm') action = actions.toggleMute
    else if (event.key === 'ArrowLeft') action = actions.seekBackward
    else if (event.key === 'ArrowRight') action = actions.seekForward
    else if (event.key === 'ArrowUp') action = actions.volumeUp
    else if (event.key === 'ArrowDown') action = actions.volumeDown
    else if (!event.shiftKey && key === 'j') action = actions.toggleNowPlaying

    if (typeof action !== 'function') return
    event.preventDefault()
    action()
  }

  target.addEventListener('keydown', handleKeydown)
  return () => target.removeEventListener('keydown', handleKeydown)
}
