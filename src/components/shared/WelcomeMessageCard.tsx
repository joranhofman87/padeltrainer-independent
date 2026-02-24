import { autoLinkText } from '@/lib/autoLink';
import { MessageSquare } from 'lucide-react';

interface WelcomeMessageCardProps {
  message: string;
  ownerName: string;
  labelKey?: string;
}

export default function WelcomeMessageCard({ message, ownerName, labelKey }: WelcomeMessageCardProps) {
  if (!message) return null;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">
          {labelKey || `Message from ${ownerName}`}
        </span>
      </div>
      <p className="text-sm text-muted-foreground whitespace-pre-line">
        {autoLinkText(message)}
      </p>
    </div>
  );
}
