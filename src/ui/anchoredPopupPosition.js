export function getAnchoredPopupPosition(anchorRect, popupHeight, viewportWidth, viewportHeight) {
  const edgePadding = 12
  const gap = 8
  const width = Math.max(0, Math.min(340, viewportWidth - edgePadding * 2))
  const left = Math.max(edgePadding, Math.min(anchorRect.right - width, viewportWidth - edgePadding - width))
  const availableBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - edgePadding)
  const availableAbove = Math.max(0, anchorRect.top - gap - edgePadding)
  const placement = availableBelow < Math.min(popupHeight, 96) && availableAbove > availableBelow ? 'above' : 'below'
  const availableHeight = placement === 'above' ? availableAbove : availableBelow
  const maxHeight = Math.min(420, availableHeight)
  const renderedHeight = Math.min(popupHeight, maxHeight)
  const proposedTop = placement === 'above' ? anchorRect.top - gap - renderedHeight : anchorRect.bottom + gap
  const top = Math.max(edgePadding, Math.min(proposedTop, viewportHeight - edgePadding - renderedHeight))

  return { top, left, width, maxHeight, placement }
}
