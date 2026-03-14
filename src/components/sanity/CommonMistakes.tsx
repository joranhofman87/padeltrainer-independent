import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface CommonMistakesProps {
  mistakes: string[] | null;
}

export function CommonMistakes({ mistakes }: CommonMistakesProps) {
  const { t } = useTranslation('marketing');
  if (!mistakes || mistakes.length === 0) return null;

  return (
    <div className="p-6 bg-destructive/5 border border-destructive/20 rounded-xl mb-8">
      <div className="flex items-start gap-3 mb-4">
        <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
        <h2 className="font-semibold text-destructive">
          {t('rules.commonMistakes', 'Common Mistakes')}
        </h2>
      </div>
      <ul className="space-y-2 ml-8">
        {mistakes.map((mistake, i) => (
          <li key={i} className="text-foreground list-disc">
            {mistake}
          </li>
        ))}
      </ul>
    </div>
  );
}
