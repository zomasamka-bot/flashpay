/**
 * Domain Management - Operations Console
 * Configure integration domains and master lock control
 */

"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Globe, Lock, Unlock, ExternalLink } from "lucide-react"
import { useDomains } from "@/lib/domains"

export default function DomainsPage() {
  const router = useRouter()
  const { domains, masterEnabled } = useDomains()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  const integrationDomains = domains.filter((d) => !d.isPrimary)

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold">Domain Management</h1>
              <p className="text-sm text-muted-foreground mt-1">Configure integration domains and access controls</p>
            </div>
            <Button
              onClick={() => router.push("/operations")}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </div>
        </div>

        {/* Master Lock Status */}
        <Card className="border-2 border-primary">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="h-5 w-5" />
                Master Lock
              </div>
              <Badge variant={masterEnabled ? "default" : "secondary"}>
                {masterEnabled ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
                {masterEnabled ? "Unlocked" : "Locked"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Master lock controls access to all integration domains
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Domains List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Domains
            </CardTitle>
            <CardDescription>
              {domains.filter((d) => d.enabled).length}/{domains.length} domains enabled
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {domains.map((domain) => (
                <div
                  key={domain.id}
                  className={`flex items-center justify-between p-4 rounded-lg border ${
                    domain.isPrimary ? "bg-primary/5 border-primary/20" : "bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`h-3 w-3 rounded-full ${domain.enabled ? "bg-green-600" : "bg-muted-foreground"}`}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{domain.name}</span>
                        {domain.isPrimary && (
                          <Badge variant="secondary" className="text-xs">
                            Primary
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-1">{domain.domain}</p>
                      {domain.description && (
                        <p className="text-xs text-muted-foreground mt-1">{domain.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={domain.enabled ? "default" : "outline"}>
                      {domain.enabled ? "Active" : "Disabled"}
                    </Badge>
                    {domain.routes && domain.routes.length > 0 && (
                      <Button
                        onClick={() => router.push(domain.routes[0])}
                        size="sm"
                        variant="ghost"
                        disabled={!domain.enabled}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Integration Domain Pages */}
        {integrationDomains.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ExternalLink className="h-5 w-5" />
                Integration Domain Pages ({integrationDomains.length})
              </CardTitle>
              <CardDescription>Access domain-specific operational pages</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {integrationDomains.map((domain) => (
                  <Button
                    key={domain.id}
                    onClick={() => router.push(domain.routes[0])}
                    variant={domain.enabled ? "default" : "outline"}
                    disabled={!domain.enabled}
                    className="w-full justify-between h-auto py-3"
                  >
                    <div className="text-left">
                      <div className="font-medium">{domain.name}</div>
                      <div className="text-xs opacity-80 font-normal">{domain.description}</div>
                    </div>
                    <ExternalLink className="h-4 w-4 ml-2 flex-shrink-0" />
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
