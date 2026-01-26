import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { 
  FileText, 
  Users, 
  AlertCircle, 
  Calendar,
  CheckCircle2,
  Clock
} from 'lucide-react';
import { type IntakeRequestWithProposal } from '@/lib/cycles';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface TrainerOption {
  id: string;
  name: string;
}

interface IntakeRequestsTableProps {
  requests: IntakeRequestWithProposal[];
  trainers?: TrainerOption[];
  onRowClick: (request: IntakeRequestWithProposal) => void;
  emptyMessage?: string;
  emptyDescription?: string;
}

export default function IntakeRequestsTable({
  requests,
  trainers = [],
  onRowClick,
  emptyMessage = 'No requests',
  emptyDescription = 'Applications will appear here when players sign up'
}: IntakeRequestsTableProps) {
  const { t } = useTranslation('cycles');

  const getTrainerNames = (request: IntakeRequestWithProposal): React.ReactNode => {
    const ids = request.preferred_trainer_ids || [];
    
    if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
    
    const names = ids
      .map(id => trainers.find(t => t.id === id)?.name)
      .filter(Boolean) as string[];
    
    if (names.length === 0) return <span className="text-muted-foreground">—</span>;
    
    if (names.length === 1) return <span className="text-sm">{names[0]}</span>;
    if (names.length === 2) return <span className="text-sm">{names[0]}, {names[1]}</span>;
    return <span className="text-sm">{names[0]} <span className="text-muted-foreground">+{names.length - 1}</span></span>;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new': return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      case 'proposed': return 'bg-purple-500/10 text-purple-600 border-purple-500/20';
      case 'confirmed': return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'waitlist': return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'rejected': return 'bg-red-500/10 text-red-600 border-red-500/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const formatAvailability = (request: IntakeRequestWithProposal) => {
    const days = request.preferred_days?.slice(0, 3).map(d => 
      d.charAt(0).toUpperCase() + d.slice(1, 3)
    ).join(', ');
    return days || '—';
  };

  const getLessonTypeBadge = (lessonType: string) => {
    const colors: Record<string, string> = {
      private: 'bg-primary/10 text-primary',
      duo: 'bg-orange-500/10 text-orange-600',
      group: 'bg-cyan-500/10 text-cyan-600',
      kids: 'bg-pink-500/10 text-pink-600'
    };
    return colors[lessonType] || 'bg-muted text-muted-foreground';
  };

  const renderProposalIndicator = (request: IntakeRequestWithProposal) => {
    // Show checkmark for confirmed
    if (request.status === 'confirmed') {
      return (
        <div className="flex items-center gap-1 text-green-600">
          <CheckCircle2 className="h-4 w-4" />
        </div>
      );
    }

    // Show proposal details for proposed status
    if (request.status === 'proposed' && request.proposal) {
      return (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-purple-500" />
            <span className="font-medium text-sm">
              {request.proposal.slot_day.slice(0, 3)} {request.proposal.slot_time.split(' - ')[0]}
            </span>
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-purple-500/10 text-purple-600 border-purple-500/20">
              {request.proposal.confidence_score}%
            </Badge>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar className="h-4 w-4">
              <AvatarImage src={request.proposal.trainer_avatar || undefined} />
              <AvatarFallback className="text-[8px] bg-muted">
                {request.proposal.trainer_name[0]}
              </AvatarFallback>
            </Avatar>
            <span className="truncate max-w-[80px]">{request.proposal.trainer_name}</span>
            {request.proposal.group_members.length > 0 && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground cursor-help">
                      +{request.proposal.group_members.length}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs font-medium mb-1">Group members:</p>
                    <ul className="text-xs">
                      {request.proposal.group_members.map((name, i) => (
                        <li key={i}>{name}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      );
    }

    // Show just proposed badge if no details available
    if (request.status === 'proposed') {
      return (
        <div className="flex items-center gap-1 text-purple-600">
          <Calendar className="h-4 w-4" />
          <span className="text-xs">{t('intakeRequests.filters.proposed')}</span>
        </div>
      );
    }

    // Show skip reason for new requests that were skipped
    if (request.status === 'new' && request.skip_reason) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 text-yellow-600 cursor-help">
                <AlertCircle className="h-4 w-4" />
                <span className="text-xs">{t(`skipReasons.${request.skip_reason}.short`)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-sm">{t(`skipReasons.${request.skip_reason}.description`)}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return <span className="text-muted-foreground text-xs">—</span>;
  };

  if (requests.length === 0) {
    return (
      <Card>
        <CardContent className="py-16">
          <div className="text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">{emptyMessage}</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {emptyDescription}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('intakeRequests.table.player')}</TableHead>
              <TableHead>{t('intakeRequests.table.lessonType')}</TableHead>
              <TableHead>{t('intakeRequests.table.rating')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('intakeRequests.table.availability')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('intakeRequests.table.preferredTrainer')}</TableHead>
              <TableHead>{t('intakeRequests.table.status')}</TableHead>
              <TableHead>{t('proposals.title')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('intakeRequests.table.applied')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow 
                key={request.id} 
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onRowClick(request)}
              >
                <TableCell>
                  <div>
                    <div className="font-medium">{request.full_name}</div>
                    <div className="text-sm text-muted-foreground">{request.email}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(Array.isArray(request.lesson_type) ? request.lesson_type : [request.lesson_type]).map((type: string) => (
                      <Badge key={type} variant="outline" className={getLessonTypeBadge(type)}>
                        {t(`application.form.lessonTypes.${type}`)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {request.rating ? (
                    <div className="flex items-center gap-1">
                      <span className="font-medium">{request.rating}</span>
                      <span className="text-xs text-muted-foreground uppercase">
                        {request.rating_system}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="text-sm">{formatAvailability(request)}</span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {getTrainerNames(request)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={getStatusColor(request.status)}>
                    {t(`intakeRequests.filters.${request.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {renderProposalIndicator(request)}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                  {format(new Date(request.created_at), 'MMM d')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
