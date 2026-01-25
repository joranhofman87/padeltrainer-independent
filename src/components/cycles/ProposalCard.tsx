import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Calendar,
  User,
  CheckCircle2,
  XCircle,
  Edit,
  ChevronDown,
  Clock,
  Target,
  Trophy,
  Box
} from 'lucide-react';
import { 
  type EnrichedProposedAssignment,
  type RationaleItem,
  updateProposedAssignmentStatus
} from '@/lib/cycles';

interface ProposalCardProps {
  proposal: EnrichedProposedAssignment;
  onStatusChange?: () => void;
}

const rationaleIcons: Record<string, React.ReactNode> = {
  time_match: <Clock className="h-4 w-4" />,
  preferred_trainer: <User className="h-4 w-4" />,
  level_compatible: <Trophy className="h-4 w-4" />,
  priority_bonus: <Target className="h-4 w-4" />,
  capacity_available: <Box className="h-4 w-4" />
};

export default function ProposalCard({ proposal, onStatusChange }: ProposalCardProps) {
  const { t } = useTranslation('cycles');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const handleApprove = async () => {
    setIsUpdating(true);
    try {
      await updateProposedAssignmentStatus(proposal.id, 'confirmed');
      toast.success('Proposal approved');
      onStatusChange?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleReject = async () => {
    setIsUpdating(true);
    try {
      await updateProposedAssignmentStatus(proposal.id, 'rejected');
      toast.success('Proposal rejected');
      onStatusChange?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600';
    if (score >= 60) return 'text-yellow-600';
    return 'text-orange-600';
  };

  const getStatusBadge = () => {
    switch (proposal.status) {
      case 'confirmed':
        return <Badge className="bg-green-500/10 text-green-600 border-green-500/20">Approved</Badge>;
      case 'rejected':
        return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
      default:
        return <Badge variant="outline">Pending</Badge>;
    }
  };

  // Get formatted slot info
  const slotDate = proposal.slot?.start_time 
    ? format(new Date(proposal.slot.start_time), 'EEEE, MMM d')
    : null;
  const slotTime = proposal.slot?.start_time && proposal.slot?.end_time
    ? `${format(new Date(proposal.slot.start_time), 'HH:mm')} - ${format(new Date(proposal.slot.end_time), 'HH:mm')}`
    : null;
  
  // Get trainer name from joined profile (array from Supabase join)
  const trainerProfile = proposal.trainer?.profile?.[0];
  const trainerName = trainerProfile?.full_name || 'Unknown Trainer';
  const trainerAvatar = trainerProfile?.avatar_url;
  const trainerInitials = trainerName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  // Get lesson title if available
  const lessonTitle = proposal.slot?.lessons?.title;

  return (
    <Card className={proposal.status === 'confirmed' ? 'border-green-500/30' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              {slotDate || t('proposals.card.slot')}
            </CardTitle>
            {slotTime && (
              <p className="text-lg font-semibold text-foreground">{slotTime}</p>
            )}
            {lessonTitle && (
              <p className="text-xs text-muted-foreground">{lessonTitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            <div className={`text-2xl font-bold ${getScoreColor(proposal.confidence_score || 0)}`}>
              {Math.round(proposal.confidence_score || 0)}%
            </div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Trainer Info */}
        <div className="flex items-center gap-3 p-2 rounded-md bg-muted/50">
          <Avatar className="h-8 w-8">
            <AvatarImage src={trainerAvatar || undefined} alt={trainerName} />
            <AvatarFallback className="text-xs">{trainerInitials}</AvatarFallback>
          </Avatar>
          <div>
            <p className="text-sm font-medium">{trainerName}</p>
            <p className="text-xs text-muted-foreground">{t('proposals.card.trainer')}</p>
          </div>
        </div>

        {/* Rationale Breakdown */}
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between">
              <span className="flex items-center gap-2">
                <Target className="h-4 w-4" />
                {t('proposals.card.rationale')}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 mt-3">
            {proposal.rationale?.map((item: RationaleItem, idx: number) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    {rationaleIcons[item.type as keyof typeof rationaleIcons] || <Target className="h-4 w-4" />}
                    <span>{t(`proposals.rationaleTypes.${item.type}`)}</span>
                  </div>
                  <span className="text-sm font-medium">+{item.score.toFixed(0)}</span>
                </div>
                <Progress value={(item.score / 40) * 100} className="h-1.5" />
                {item.detail && (
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                )}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>

        {/* Actions */}
        {proposal.status === 'proposed' && (
          <div className="flex gap-2 pt-2">
            <Button 
              size="sm" 
              className="flex-1"
              onClick={handleApprove}
              disabled={isUpdating}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              {t('proposals.actions.approve')}
            </Button>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => {/* TODO: Open slot picker */}}
              disabled={isUpdating}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button 
              variant="outline" 
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleReject}
              disabled={isUpdating}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
