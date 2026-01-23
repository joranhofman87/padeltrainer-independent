import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
  Users,
  Trophy,
  Box
} from 'lucide-react';
import { 
  type ProposedAssignment,
  type RationaleItem,
  updateProposedAssignmentStatus
} from '@/lib/cycles';

interface ProposalCardProps {
  proposal: ProposedAssignment;
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

  return (
    <Card className={proposal.status === 'approved' ? 'border-green-500/30' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Proposed Slot
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Slot ID: {proposal.slot_id?.slice(0, 8)}...
            </p>
          </div>
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            <div className={`text-2xl font-bold ${getScoreColor(proposal.confidence_score)}`}>
              {Math.round(proposal.confidence_score)}%
            </div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Trainer Info */}
        <div className="flex items-center gap-2 text-sm">
          <User className="h-4 w-4 text-muted-foreground" />
          <span>Trainer ID: {proposal.trainer_id?.slice(0, 8)}...</span>
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
            {proposal.rationale.map((item: RationaleItem, idx: number) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    {rationaleIcons[item.factor as keyof typeof rationaleIcons] || <Target className="h-4 w-4" />}
                    <span>{t(`proposals.rationaleTypes.${item.factor}`)}</span>
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
