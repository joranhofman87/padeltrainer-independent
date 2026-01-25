import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  User,
  Mail,
  Phone,
  Calendar,
  Clock,
  MapPin,
  Star,
  FileText,
  CheckCircle2,
  XCircle,
  Clock3,
  Sparkles,
  AlertCircle
} from 'lucide-react';
import { 
  type IntakeRequest, 
  type EnrichedProposedAssignment,
  updateIntakeRequestStatus,
  getProposedAssignmentForRequest
} from '@/lib/cycles';
import ProposalCard from './ProposalCard';

interface IntakeRequestDetailSheetProps {
  request: IntakeRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange?: () => void;
}

export default function IntakeRequestDetailSheet({
  request,
  open,
  onOpenChange,
  onStatusChange
}: IntakeRequestDetailSheetProps) {
  const { t } = useTranslation('cycles');
  const [proposal, setProposal] = useState<EnrichedProposedAssignment | null>(null);
  const [isLoadingProposal, setIsLoadingProposal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const fetchProposal = async () => {
      if (!request) return;
      
      setIsLoadingProposal(true);
      try {
        const data = await getProposedAssignmentForRequest(request.id);
        setProposal(data);
      } catch (error) {
        console.error('Error fetching proposal:', error);
      } finally {
        setIsLoadingProposal(false);
      }
    };

    if (open && request) {
      fetchProposal();
    }
  }, [request, open]);

  const handleStatusChange = async (newStatus: IntakeRequest['status']) => {
    if (!request) return;

    setIsUpdating(true);
    try {
      await updateIntakeRequestStatus(request.id, newStatus);
      toast.success(`Status updated to ${newStatus}`);
      onStatusChange?.();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const getDayLabel = (day: string) => {
    return t(`application.form.days.${day}`);
  };

  const formatTimeWindow = (window: { start: string; end: string }) => {
    return `${window.start} - ${window.end}`;
  };

  if (!request) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('intakeRequests.detail.title')}</SheetTitle>
          <SheetDescription>
            Applied {format(new Date(request.created_at), 'MMM d, yyyy')}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Contact Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" />
                {t('intakeRequests.detail.contactInfo')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{request.full_name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{request.email}</span>
              </div>
              {request.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span>{request.phone}</span>
                </div>
              )}
              {request.rating && (
                <div className="flex items-center gap-2 text-sm">
                  <Star className="h-4 w-4 text-muted-foreground" />
                  <span>{request.rating} ({request.rating_system})</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {t('intakeRequests.detail.preferences')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Lesson type</span>
                <Badge variant="secondary">
                  {t(`application.form.lessonTypes.${request.lesson_type}`)}
                </Badge>
              </div>
              {request.preferred_duration_minutes && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Duration</span>
                  <span className="text-sm font-medium">{request.preferred_duration_minutes} min</span>
                </div>
              )}
              {request.location_id && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Location</span>
                  <span className="text-sm font-medium flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" />
                    Specified
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Availability */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {t('intakeRequests.detail.availability')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {request.preferred_days && request.preferred_days.length > 0 && (
                <div>
                  <span className="text-sm text-muted-foreground block mb-2">Preferred days</span>
                  <div className="flex flex-wrap gap-1.5">
                    {request.preferred_days.map(day => (
                      <Badge key={day} variant="outline" className="text-xs">
                        {getDayLabel(day)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {request.preferred_time_windows && request.preferred_time_windows.length > 0 && (
                <div>
                  <span className="text-sm text-muted-foreground block mb-2">Time preferences</span>
                  <div className="flex flex-wrap gap-1.5">
                    {request.preferred_time_windows.map((window, idx) => (
                      <Badge key={idx} variant="secondary" className="text-xs">
                        <Clock3 className="h-3 w-3 mr-1" />
                        {window.start && window.end ? formatTimeWindow(window as { start: string; end: string }) : 'Custom'}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          {request.notes && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  {t('intakeRequests.detail.notes')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {request.notes}
                </p>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Proposal Section */}
          <div>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {t('intakeRequests.detail.proposal')}
            </h3>
            
            {isLoadingProposal ? (
              <Card className="animate-pulse">
                <CardContent className="h-32" />
              </Card>
            ) : proposal ? (
              <ProposalCard 
                proposal={proposal} 
                onStatusChange={onStatusChange}
              />
            ) : request.skip_reason ? (
              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="py-4">
                  <div className="flex items-center gap-2 text-yellow-600 mb-2">
                    <AlertCircle className="h-5 w-5" />
                    <span className="font-medium">
                      {t(`skipReasons.${request.skip_reason}.title`)}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`skipReasons.${request.skip_reason}.description`)}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('intakeRequests.detail.noProposal')}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {request.status !== 'confirmed' && (
              <Button 
                size="sm" 
                onClick={() => handleStatusChange('confirmed')}
                disabled={isUpdating}
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.confirm')}
              </Button>
            )}
            {request.status !== 'waitlist' && (
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => handleStatusChange('waitlist')}
                disabled={isUpdating}
              >
                <Clock3 className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.waitlist')}
              </Button>
            )}
            {request.status !== 'rejected' && (
              <Button 
                variant="outline" 
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => handleStatusChange('rejected')}
                disabled={isUpdating}
              >
                <XCircle className="h-4 w-4 mr-1" />
                {t('intakeRequests.actions.reject')}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
