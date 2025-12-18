import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { VersionInfo } from '@tracearr/shared';
import { api } from '@/lib/api';

/**
 * Hook to fetch current version info and update status
 * Polls every 6 hours to match server-side check frequency
 */
export function useVersion() {
  return useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: api.version.get,
    // Refresh every 6 hours (matches server check interval)
    staleTime: 1000 * 60 * 60 * 6,
    // Refetch in background when window refocuses
    refetchOnWindowFocus: true,
    // Keep retrying - version endpoint should always be available
    retry: 3,
  });
}

/**
 * Hook to force a version check (admin only)
 */
export function useForceVersionCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.version.check,
    onSuccess: () => {
      // Invalidate version query to refetch after check completes
      // Small delay to allow the server to process the check
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['version'] });
      }, 2000);
    },
  });
}
