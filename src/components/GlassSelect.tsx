import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'

type GlassSelectOption = {
  label: string
  value: string
}

type GlassSelectProps = {
  value: string
  onChange: (value: string) => void
  options: GlassSelectOption[]
  disabled?: boolean
}

type MenuPosition = {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
  placement: 'bottom' | 'top'
}

const MENU_MAX_HEIGHT = 288
const MENU_GAP = 6
const VIEWPORT_MARGIN = 10
// One option row (36px) plus the 2px gap between rows.
const OPTION_STRIDE = 38
const MENU_PADDING = 12

function computePosition(
  trigger: HTMLElement,
  optionCount: number,
): MenuPosition {
  const rect = trigger.getBoundingClientRect()

  const desired = Math.min(
    MENU_MAX_HEIGHT,
    optionCount * OPTION_STRIDE + MENU_PADDING,
  )

  const spaceBelow =
    window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN

  // Open downwards when it fits, otherwise on the side with more room.
  const placement: MenuPosition['placement'] =
    spaceBelow >= desired || spaceBelow >= spaceAbove ? 'bottom' : 'top'

  const available = placement === 'bottom' ? spaceBelow : spaceAbove
  const maxHeight = Math.max(96, Math.min(MENU_MAX_HEIGHT, available))

  const width = rect.width
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  )

  return placement === 'bottom'
    ? { left, width, top: rect.bottom + MENU_GAP, maxHeight, placement }
    : {
        left,
        width,
        bottom: window.innerHeight - rect.top + MENU_GAP,
        maxHeight,
        placement,
      }
}

/**
 * Liquid-glass dropdown that renders inside the application window instead of
 * opening the operating system's native <select> popup.
 *
 * The menu is rendered in a portal on document.body with fixed positioning so
 * it is never clipped by the scrollable page area and its glass blur can see
 * the application content behind it.
 */
export default function GlassSelect({
  value,
  onChange,
  options,
  disabled = false,
}: GlassSelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollToActiveRef = useRef(false)
  const listId = useId()

  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = options[selectedIndex] ?? options[0]

  // A disabled select (for example while recording) can never stay open.
  const isOpen = open && !disabled && position !== null

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || disabled || options.length === 0) return

    setPosition(computePosition(trigger, options.length))
    setActiveIndex(selectedIndex)
    setOpen(true)
  }, [disabled, options.length, selectedIndex])

  const choose = (nextValue: string) => {
    if (nextValue !== value) onChange(nextValue)
    setOpen(false)
    triggerRef.current?.focus()
  }

  // Close on outside click, page scroll, window resize and window blur.
  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }

    const handleScroll = (event: Event) => {
      const target = event.target
      // Scrolling the option list itself must not close the menu.
      if (target instanceof Node && menuRef.current?.contains(target)) return
      setOpen(false)
    }

    const handleClose = () => setOpen(false)

    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleClose)
    window.addEventListener('blur', handleClose)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('blur', handleClose)
    }
  }, [isOpen])

  // Center the selected option when the menu opens.
  useEffect(() => {
    if (!isOpen) return

    const list = listRef.current
    const element = list?.querySelector<HTMLElement>('[data-selected="true"]')
    if (!list || !element) return

    list.scrollTop =
      element.offsetTop - (list.clientHeight - element.offsetHeight) / 2
  }, [isOpen])

  // Keep the keyboard-highlighted option visible.
  useEffect(() => {
    if (!isOpen || !scrollToActiveRef.current) return
    scrollToActiveRef.current = false

    const list = listRef.current
    const element = list?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    )
    if (!list || !element) return

    const top = element.offsetTop
    const bottom = top + element.offsetHeight

    if (top < list.scrollTop) {
      list.scrollTop = Math.max(0, top - 6)
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 6
    }
  }, [activeIndex, isOpen])

  const moveActive = (index: number) => {
    scrollToActiveRef.current = true
    setActiveIndex(Math.min(options.length - 1, Math.max(0, index)))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return

    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      case 'ArrowDown':
        event.preventDefault()
        moveActive(activeIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveActive(activeIndex < 0 ? 0 : activeIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        moveActive(0)
        break
      case 'End':
        event.preventDefault()
        moveActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (activeIndex >= 0 && options[activeIndex]) {
          choose(options[activeIndex].value)
        } else {
          setOpen(false)
        }
        break
      default:
        break
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        data-open={isOpen}
        onClick={() => {
          if (isOpen) {
            setOpen(false)
          } else {
            openMenu()
          }
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          // Stops the browser from firing a second click when Space is released.
          if (event.key === ' ') event.preventDefault()
        }}
        className="glass-field relative flex w-full items-center rounded-xl px-3 py-3 pr-9 text-left text-xs disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="label-font block min-w-0 flex-1 truncate text-xs">
          {selected?.label ?? ''}
        </span>

        <ChevronDown
          size={14}
          className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-red-300' : ''
          }`}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {isOpen && position && (
            <motion.div
              ref={menuRef}
              key="glass-menu"
              initial={{
                opacity: 0,
                y: position.placement === 'bottom' ? -6 : 6,
                scale: 0.97,
              }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{
                opacity: 0,
                y: position.placement === 'bottom' ? -4 : 4,
                scale: 0.98,
              }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              style={{
                left: position.left,
                width: position.width,
                top: position.top,
                bottom: position.bottom,
                transformOrigin:
                  position.placement === 'bottom' ? 'top center' : 'bottom center',
              }}
              onMouseDown={(event) => {
                // Keeps keyboard focus on the trigger while clicking options.
                event.preventDefault()
              }}
              className="glass-menu fixed z-[1000] overflow-hidden rounded-2xl"
            >
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                style={{ maxHeight: position.maxHeight }}
                className="glass-menu-list relative flex flex-col gap-0.5 overflow-y-auto p-1.5"
              >
                {options.map((option, index) => {
                  const isSelected = index === selectedIndex

                  return (
                    <div
                      key={option.value}
                      role="option"
                      aria-selected={isSelected}
                      data-index={index}
                      data-selected={isSelected}
                      data-active={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(option.value)}
                      className="glass-option"
                    >
                      <span className="label-font min-w-0 flex-1 truncate text-xs">
                        {option.label}
                      </span>

                      {isSelected && (
                        <Check size={14} className="shrink-0 text-red-300" />
                      )}
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
