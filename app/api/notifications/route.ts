/**
 * Notifications API endpoint
 * GET /api/notifications?merchantId=X - Get notifications
 * POST /api/notifications/mark-read - Mark notification as read
 */

import { NextRequest, NextResponse } from 'next/server'
import { getUnreadNotifications, markNotificationAsRead } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get('merchantId')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    if (!merchantId) {
      return NextResponse.json({ error: 'merchantId required' }, { status: 400 })
    }

    console.log('[Notifications API] Fetching for merchant:', merchantId)

    // Get notifications using existing DB function
    const notifications = await getUnreadNotifications(merchantId)

    // Simple client-side pagination
    const paginated = notifications.slice(offset, offset + limit)

    return NextResponse.json({
      notifications: paginated,
      total: notifications.length,
      pagination: {
        limit,
        offset,
      },
      merchantId,
    })
  } catch (error) {
    console.error('[Notifications API] GET failed:', error)
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action === 'mark-read') {
      const body = await request.json().catch(() => ({}))
      const { notificationId } = body

      if (!notificationId) {
        return NextResponse.json(
          { error: 'notificationId required' },
          { status: 400 }
        )
      }

      console.log('[Notifications API] Marking as read:', notificationId)

      const result = await markNotificationAsRead(notificationId)

      if (!result) {
        return NextResponse.json(
          { error: 'Failed to mark notification' },
          { status: 500 }
        )
      }

      return NextResponse.json({
        status: 'success',
        notificationId,
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('[Notifications API] POST failed:', error)
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    )
  }
}
