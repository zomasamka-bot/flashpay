"use client"

import { useState, useEffect } from "react"

const STORAGE_KEY = "flashpay_owner_auth"
const CORRECT_PASSWORD = "761282"

export function usePasswordAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Check if user is already authenticated
    const checkAuth = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY)
        setIsAuthenticated(stored === "true")
      } catch (error) {
        console.error("[v0] Error checking auth:", error)
        setIsAuthenticated(false)
      } finally {
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [])

  const login = (password: string): boolean => {
    if (password === CORRECT_PASSWORD) {
      try {
        localStorage.setItem(STORAGE_KEY, "true")
        setIsAuthenticated(true)
        return true
      } catch (error) {
        console.error("[v0] Error saving auth:", error)
        return false
      }
    }
    return false
  }

  const logout = () => {
    try {
      localStorage.removeItem(STORAGE_KEY)
      setIsAuthenticated(false)
    } catch (error) {
      console.error("[v0] Error logging out:", error)
    }
  }

  return {
    isAuthenticated,
    isLoading,
    login,
    logout,
  }
}
