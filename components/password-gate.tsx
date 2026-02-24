"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Shield, Lock } from "lucide-react"
import { usePasswordAuth } from "@/lib/use-password-auth"

interface PasswordGateProps {
  children: React.ReactNode
}

export function PasswordGate({ children }: PasswordGateProps) {
  const { isAuthenticated, isLoading, login } = usePasswordAuth()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [inputFocused, setInputFocused] = useState(false)

  useEffect(() => {
    // Auto-focus on mount
    if (!isAuthenticated && !isLoading) {
      const timer = setTimeout(() => setInputFocused(true), 100)
      return () => clearTimeout(timer)
    }
  }, [isAuthenticated, isLoading])

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Shield className="h-12 w-12 mx-auto mb-4 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault()
      setError("")

      if (password.length !== 6) {
        setError("Password must be 6 digits")
        return
      }

      const success = login(password)

      if (!success) {
        setError("Incorrect password")
        setPassword("")
      }
    }

    const handlePasswordChange = (value: string) => {
      // Only allow digits and max 6 characters
      const digits = value.replace(/\D/g, "").slice(0, 6)
      setPassword(digits)
      setError("")
    }

    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-muted/30">
        <Card className="w-full max-w-md border-2">
          <CardHeader className="text-center space-y-2">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-2">
              <Lock className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-2xl">Owner Access</CardTitle>
            <CardDescription>Enter your 6-digit password to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="••••••"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  autoFocus={inputFocused}
                  className="text-center text-2xl tracking-widest h-14 font-mono"
                  maxLength={6}
                />
                {error && <p className="text-sm text-destructive text-center">{error}</p>}
              </div>

              <Button type="submit" className="w-full h-12 text-lg" disabled={password.length !== 6}>
                <Shield className="h-5 w-5 mr-2" />
                Unlock
              </Button>

              <div className="text-center">
                <p className="text-xs text-muted-foreground">This password is stored locally on your device</p>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
