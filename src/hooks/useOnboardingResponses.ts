import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getOnboardingResponses,
  upsertOnboardingResponses,
  type OnboardingResponsesPartial,
  type OnboardingResponsesRow,
} from '@/lib/onboardingResponses';

export const onboardingResponsesQueryKey = (trainerProfileId: string) =>
  ['trainer-onboarding-responses', trainerProfileId] as const;

export function useOnboardingResponses(trainerProfileId?: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: onboardingResponsesQueryKey(trainerProfileId ?? ''),
    queryFn: () => getOnboardingResponses(trainerProfileId!),
    enabled: !!trainerProfileId,
  });

  const mutation = useMutation({
    mutationFn: (partial: OnboardingResponsesPartial) =>
      upsertOnboardingResponses(trainerProfileId!, partial),
    onSuccess: (saved: OnboardingResponsesRow) => {
      if (trainerProfileId) {
        queryClient.setQueryData(onboardingResponsesQueryKey(trainerProfileId), saved);
        queryClient.invalidateQueries({
          queryKey: onboardingResponsesQueryKey(trainerProfileId),
        });
      }
    },
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    saveResponses: mutation.mutateAsync,
    saveResponsesSync: mutation.mutate,
    isSaving: mutation.isPending,
    saveError: mutation.error,
  };
}

export function useSaveOnboardingResponses(trainerProfileId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (partial: OnboardingResponsesPartial) =>
      upsertOnboardingResponses(trainerProfileId!, partial),
    onSuccess: (saved: OnboardingResponsesRow) => {
      if (trainerProfileId) {
        queryClient.setQueryData(onboardingResponsesQueryKey(trainerProfileId), saved);
        queryClient.invalidateQueries({
          queryKey: onboardingResponsesQueryKey(trainerProfileId),
        });
      }
    },
  });
}
