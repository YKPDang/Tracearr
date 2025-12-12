import { Info } from 'lucide-react';
import type { NotificationChannelRouting, NotificationEventType } from '@tracearr/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useChannelRouting, useUpdateChannelRouting } from '@/hooks/queries';

// Display names and descriptions for event types
const EVENT_CONFIG: Record<
  NotificationEventType,
  { name: string; description: string }
> = {
  violation_detected: {
    name: 'Rule Violation',
    description: 'A user triggered a rule violation (e.g., concurrent streams, impossible travel)',
  },
  new_device: {
    name: 'New Device',
    description: 'A user logged in from a new device for the first time',
  },
  trust_score_changed: {
    name: 'Trust Score Changed',
    description: "A user's trust score changed significantly",
  },
  stream_started: {
    name: 'Stream Started',
    description: 'A user started watching content',
  },
  stream_stopped: {
    name: 'Stream Stopped',
    description: 'A user stopped watching content',
  },
  concurrent_streams: {
    name: 'Concurrent Streams',
    description: 'Multiple streams detected from the same user',
  },
  server_down: {
    name: 'Server Offline',
    description: 'A media server became unreachable',
  },
  server_up: {
    name: 'Server Online',
    description: 'A media server came back online',
  },
};

// Order of events in the table (security first, then streams, then server)
const EVENT_ORDER: NotificationEventType[] = [
  'violation_detected',
  'new_device',
  'trust_score_changed',
  'stream_started',
  'stream_stopped',
  'concurrent_streams',
  'server_down',
  'server_up',
];

interface NotificationRoutingMatrixProps {
  discordConfigured: boolean;
  webhookConfigured: boolean;
}

export function NotificationRoutingMatrix({
  discordConfigured,
  webhookConfigured,
}: NotificationRoutingMatrixProps) {
  const { data: routingData, isLoading } = useChannelRouting();
  const updateRouting = useUpdateChannelRouting();

  // Build a map for quick lookup
  const routingMap = new Map<NotificationEventType, NotificationChannelRouting>();
  routingData?.forEach((r) => routingMap.set(r.eventType, r));

  const handleToggle = (
    eventType: NotificationEventType,
    channel: 'discord' | 'webhook',
    checked: boolean
  ) => {
    updateRouting.mutate({
      eventType,
      ...(channel === 'discord' ? { discordEnabled: checked } : { webhookEnabled: checked }),
    });
  };

  // Check if at least one channel is configured
  const hasAnyChannel = discordConfigured || webhookConfigured;

  if (!hasAnyChannel) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4 bg-muted/50 rounded-lg">
        <Info className="h-4 w-4" />
        <span>Configure a Discord or Custom Webhook URL above to enable notification routing.</span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {EVENT_ORDER.map((eventType) => (
          <Skeleton key={eventType} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Table */}
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left py-3 px-4 font-medium text-sm">Event</th>
                {discordConfigured && (
                  <th className="text-center py-3 px-4 font-medium text-sm w-24">Discord</th>
                )}
                {webhookConfigured && (
                  <th className="text-center py-3 px-4 font-medium text-sm w-24">Webhook</th>
                )}
              </tr>
            </thead>
            <tbody>
              {EVENT_ORDER.map((eventType, index) => {
                const routing = routingMap.get(eventType);
                const config = EVENT_CONFIG[eventType];

                return (
                  <tr
                    key={eventType}
                    className={index < EVENT_ORDER.length - 1 ? 'border-b' : ''}
                  >
                    <td className="py-3 px-4">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm cursor-help border-b border-dotted border-muted-foreground/50">
                            {config.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          <p>{config.description}</p>
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    {discordConfigured && (
                      <td className="py-3 px-4 text-center">
                        <Checkbox
                          checked={routing?.discordEnabled ?? false}
                          onCheckedChange={(checked) =>
                            handleToggle(eventType, 'discord', checked === true)
                          }
                          disabled={updateRouting.isPending}
                        />
                      </td>
                    )}
                    {webhookConfigured && (
                      <td className="py-3 px-4 text-center">
                        <Checkbox
                          checked={routing?.webhookEnabled ?? false}
                          onCheckedChange={(checked) =>
                            handleToggle(eventType, 'webhook', checked === true)
                          }
                          disabled={updateRouting.isPending}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Info about push notifications */}
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Push notifications are configured per-device in the mobile app.
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}
