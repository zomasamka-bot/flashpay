/**
 * In-App Notification Service
 * Manages user notifications with sound alerts and persistence
 * Future: Email integration ready
 */

export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  timestamp: number
  read: boolean
  actionUrl?: string
  soundEnabled?: boolean
}

/**
 * Store notifications in localStorage
 */
class NotificationStore {
  private readonly STORAGE_KEY = 'flashpay_notifications'

  getAll(): Notification[] {
    if (typeof window === 'undefined') return []
    try {
      const data = localStorage.getItem(this.STORAGE_KEY)
      return data ? JSON.parse(data) : []
    } catch {
      return []
    }
  }

  add(notification: Omit<Notification, 'id' | 'timestamp' | 'read'>): Notification {
    const newNotif: Notification = {
      ...notification,
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      read: false,
    }

    const all = this.getAll()
    const updated = [newNotif, ...all].slice(0, 50) // Keep last 50
    
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(updated))
    }

    return newNotif
  }

  markAsRead(id: string): void {
    const all = this.getAll()
    const updated = all.map(n => n.id === id ? { ...n, read: true } : n)
    
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(updated))
    }
  }

  clear(): void {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(this.STORAGE_KEY)
    }
  }
}

/**
 * Play notification sound
 */
function playNotificationSound(type: NotificationType) {
  if (typeof window === 'undefined') return

  // Create audio context for sound generation
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)

    // Different frequencies for different notification types
    const frequencies: Record<NotificationType, number> = {
      success: 800,  // Higher pitch for success
      error: 400,    // Lower pitch for error
      warning: 600,  // Medium pitch for warning
      info: 500,     // Info pitch
    }

    oscillator.frequency.value = frequencies[type]
    oscillator.type = 'sine'

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5)

    oscillator.start(audioContext.currentTime)
    oscillator.stop(audioContext.currentTime + 0.5)
  } catch (error) {
    console.warn('[Notification] Could not play sound:', error)
  }
}

// Global store instance
const store = new NotificationStore()

/**
 * Notify user of transfer success
 */
export function notifyTransferSuccess(transferId: string, amount: number, merchantName?: string) {
  const notification = store.add({
    type: 'success',
    title: 'Transfer Sent Successfully',
    message: `${amount} Pi transferred to ${merchantName || 'merchant wallet'}. Transfer ID: ${transferId.slice(0, 8)}...`,
    soundEnabled: true,
  })

  playNotificationSound('success')
  console.log('[Notification] Transfer success:', notification)

  return notification
}

/**
 * Notify user of transfer failure
 */
export function notifyTransferFailed(transferId: string, reason: string, retryAvailable: boolean) {
  const notification = store.add({
    type: 'error',
    title: 'Transfer Failed',
    message: `Transfer could not complete: ${reason}${retryAvailable ? ' Retrying...' : ' Please try again later.'}`,
    soundEnabled: true,
  })

  playNotificationSound('error')
  console.log('[Notification] Transfer failed:', notification)

  return notification
}

/**
 * Notify user of transfer retry
 */
export function notifyTransferRetry(transferId: string, attempt: number, maxAttempts: number) {
  const notification = store.add({
    type: 'warning',
    title: `Retrying Transfer (Attempt ${attempt}/${maxAttempts})`,
    message: `System is automatically retrying to send funds. Transfer ID: ${transferId.slice(0, 8)}...`,
    soundEnabled: false,
  })

  console.log('[Notification] Transfer retry:', notification)
  return notification
}

/**
 * Notify user of transfer pending
 */
export function notifyTransferPending(amount: number, merchantName?: string) {
  const notification = store.add({
    type: 'info',
    title: 'Transfer Initiated',
    message: `Sending ${amount} Pi to ${merchantName || 'merchant wallet'}...`,
    soundEnabled: false,
  })

  console.log('[Notification] Transfer pending:', notification)
  return notification
}

/**
 * Notify user of payment completion
 */
export function notifyPaymentComplete(amount: number, merchantName?: string) {
  const notification = store.add({
    type: 'success',
    title: 'Payment Completed',
    message: `${amount} Pi payment confirmed. Funds will transfer to ${merchantName || 'merchant'} shortly.`,
    soundEnabled: true,
  })

  playNotificationSound('success')
  console.log('[Notification] Payment complete:', notification)

  return notification
}

/**
 * Get all notifications
 */
export function getNotifications(): Notification[] {
  return store.getAll()
}

/**
 * Get unread notifications
 */
export function getUnreadNotifications(): Notification[] {
  return store.getAll().filter(n => !n.read)
}

/**
 * Mark notification as read
 */
export function markNotificationAsRead(id: string): void {
  store.markAsRead(id)
}

/**
 * Clear all notifications
 */
export function clearAllNotifications(): void {
  store.clear()
}

/**
 * Get notification count
 */
export function getNotificationCount(): number {
  return getUnreadNotifications().length
}
