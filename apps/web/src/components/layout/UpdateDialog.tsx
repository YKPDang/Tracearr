import { useMemo } from 'react';
import { ExternalLink, ArrowRight, Terminal, Package, Sparkles } from 'lucide-react';
import type { VersionInfo } from '@tracearr/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: VersionInfo;
}

/**
 * Dialog showing update details including version info, type, and release notes
 */
export function UpdateDialog({ open, onOpenChange, version }: UpdateDialogProps) {
  const { current, latest } = version;

  // Determine update type label
  const updateType = useMemo(() => {
    if (!latest) return null;

    // Current is beta, latest is stable of same base version
    if (current.isPrerelease && !latest.isPrerelease) {
      return { label: 'Stable Release', variant: 'default' as const, icon: Sparkles };
    }

    // Current is beta, latest is newer beta
    if (current.isPrerelease && latest.isPrerelease) {
      return { label: 'Beta Update', variant: 'secondary' as const, icon: Package };
    }

    // Current is stable, latest is newer stable
    return { label: 'New Version', variant: 'default' as const, icon: Sparkles };
  }, [current, latest]);

  // Format the docker pull command
  const dockerCommand = useMemo(() => {
    if (!latest) return '';
    // Use 'next' tag for prereleases, 'latest' for stable
    const tag = latest.isPrerelease ? 'next' : 'latest';
    return `docker pull ghcr.io/connorgallopo/tracearr:${tag}`;
  }, [latest]);

  if (!latest || !updateType) return null;

  const currentDisplay = current.tag ?? `v${current.version}`;
  const latestDisplay = latest.tag;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="flex items-center gap-2">
              <updateType.icon className="h-5 w-5 text-green-500" />
              Update Available
            </DialogTitle>
            <Badge variant={updateType.variant} className="text-xs">
              {updateType.label}
            </Badge>
          </div>
          <DialogDescription className="flex items-center gap-2 pt-1">
            <span className="text-muted-foreground">{currentDisplay}</span>
            <ArrowRight className="text-muted-foreground h-3 w-3" />
            <span className="font-medium text-green-600 dark:text-green-400">{latestDisplay}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Release name if different from tag */}
          {latest.releaseName && latest.releaseName !== latest.tag && (
            <div className="text-sm font-medium">{latest.releaseName}</div>
          )}

          {/* Release notes */}
          {latest.releaseNotes && (
            <div className="space-y-2">
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Release Notes
              </div>
              <ScrollArea className="h-48 rounded-md border p-3">
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
                    {latest.releaseNotes}
                  </pre>
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Update command */}
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Update Command
            </div>
            <div className="bg-muted flex items-center gap-2 rounded-md p-3 font-mono text-sm">
              <Terminal className="text-muted-foreground h-4 w-4 shrink-0" />
              <code className="flex-1 select-all">{dockerCommand}</code>
            </div>
            <p className="text-muted-foreground text-xs">
              After pulling, restart your container to apply the update.
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Later
            </Button>
            <Button asChild className="gap-2">
              <a href={latest.releaseUrl} target="_blank" rel="noopener noreferrer">
                View on GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
