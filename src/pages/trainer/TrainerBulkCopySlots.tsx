import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import BulkCopySlotsWizard from '@/components/cycles/BulkCopySlotsWizard';
import { Skeleton } from '@/components/ui/skeleton';

export default function TrainerBulkCopySlots() {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);
  if (!userId) return <div className="container max-w-3xl mx-auto py-6"><Skeleton className="h-64 w-full" /></div>;
  return <BulkCopySlotsWizard ownerType="trainer" ownerId={userId} backHref="/app/trainer/cycles" />;
}
