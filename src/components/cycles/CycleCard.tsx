import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { format } from 'date-fns';
import { 
  Calendar, 
  Users, 
  Clock, 
  MoreVertical, 
  Edit, 
  Trash2,
  Play,
  Square,
  Archive,
  FileText,
  Link2,
  Euro,
  PartyPopper,
  Banknote,
  CreditCard,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type Cycle, getIntakeRequestCounts, updateCycle, deleteCycle } from '@/lib/cycles';
import { toast } from 'sonner';
import { getMarketingUrl } from '@/lib/domains';

interface CycleCardProps {
  cycle: Cycle;
  onEdit?: (cycle: Cycle) => void;
  onDeleted?: () => void;
  showActions?: boolean;
}

export default function CycleCard({ cycle, onEdit, onDeleted, showActions = true }: CycleCardProps) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const location = useLocation();
  const [counts, setCounts] = useState<Record<string, number>>({});

  const getBasePath = () => {
    if (location.pathname.startsWith('/club')) return '/club';
    if (location.pathname.startsWith('/trainer')) return '/trainer';
    return '';
  };
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    async function loadCounts() {
      try {
        const data = await getIntakeRequestCounts(cycle.id);
        setCounts(data);
      } catch (error) {
        console.error('Error loading counts:', error);
      }
    }
    loadCounts();
  }, [cycle.id]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'open': return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'closed': return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'archived': return 'bg-muted text-muted-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const handleStatusChange = async (newStatus: Cycle['status']) => {
    setIsUpdating(true);
    try {
      await updateCycle(cycle.id, { status: newStatus });
      toast.success(t(`status.${newStatus}`));
      onDeleted?.(); // Trigger refresh
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    const isRegistration = cycle.type === 'registration';
    if (!confirm(isRegistration ? t('deleteRegistration', 'Delete this registration?') : t('deleteCycle') + '?')) return;
    
    try {
      await deleteCycle(cycle.id);
      toast.success(isRegistration ? t('common:deleted', 'Deleted') : 'Cycle deleted');
      onDeleted?.();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const copyRegistrationLink = () => {
    const lang = document.documentElement.lang || 'nl';
    const url = getMarketingUrl(`register/${cycle.id}`, lang);
    navigator.clipboard.writeText(url);
    toast.success(t('actions.linkCopied'));
  };

  return (
    <Card className="hover:border-primary/30 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">{cycle.name}</CardTitle>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>
                {format(new Date(cycle.start_date), 'MMM d')} - {format(new Date(cycle.end_date), 'MMM d, yyyy')}
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-wrap">
            {cycle.type === 'event' && (
              <Badge variant="outline" className="text-xs gap-1 bg-purple-500/10 text-purple-600 border-purple-500/20">
                <PartyPopper className="h-3 w-3" />
                {t('type.event', 'Event')}
              </Badge>
            )}
            <Badge variant="outline" className={getStatusColor(cycle.status)}>
              {t(`status.${cycle.status}`)}
            </Badge>
            
            {/* Payment method badge for events */}
            {cycle.type === 'event' && (() => {
              const pm = (cycle.settings as any)?.payment_methods;
              if (!pm) return null;
              return (
                <Badge variant="outline" className="text-xs gap-1">
                  {pm === 'online' && <><CreditCard className="h-3 w-3" />{t('paymentBadge.online', 'Online')}</>}
                  {pm === 'cash' && <><Banknote className="h-3 w-3" />{t('paymentBadge.cash', 'Cash')}</>}
                  {pm === 'both' && <><CreditCard className="h-3 w-3" />{t('paymentBadge.both', 'Online / Cash')}</>}
                </Badge>
              );
            })()}
            
            {/* Payment timing badge for non-events */}
            {cycle.type !== 'event' && (() => {
              const settings = cycle.settings as any;
              const timing = settings?.payment_timing || (settings?.mark_as_paid ? 'manual' : 'upfront');
              if (timing === 'upfront') return null;
              return (
                <Badge variant="outline" className="text-xs gap-1">
                  <Euro className="h-3 w-3" />
                  {timing === 'invoice_after_weeks' 
                    ? t('paymentBadge.invoice_after_weeks', { count: settings?.invoice_delay_weeks || 2 })
                    : t('paymentBadge.manual')}
                </Badge>
              );
            })()}
            
            {showActions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit?.(cycle)}>
                    <Edit className="mr-2 h-4 w-4" />
                    {cycle.type === 'registration' ? t('editRegistration', 'Edit Registration') : t('editCycle')}
                  </DropdownMenuItem>
                  
                  <DropdownMenuItem onClick={() => navigate(`${getBasePath()}/intake-requests?cycle=${cycle.id}`)}>
                    <FileText className="mr-2 h-4 w-4" />
                    {t('actions.viewRequests')}
                  </DropdownMenuItem>
                  
                  
                  <DropdownMenuSeparator />
                  
                  {cycle.status === 'draft' && (
                    <DropdownMenuItem 
                      onClick={() => handleStatusChange('open')}
                      disabled={isUpdating}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      {t('actions.openEnrollment')}
                    </DropdownMenuItem>
                  )}
                  
                  {cycle.status === 'open' && (
                    <DropdownMenuItem 
                      onClick={() => handleStatusChange('closed')}
                      disabled={isUpdating}
                    >
                      <Square className="mr-2 h-4 w-4" />
                      {t('actions.closeEnrollment')}
                    </DropdownMenuItem>
                  )}
                  
                  {(cycle.status === 'closed' || cycle.status === 'open') && (
                    <DropdownMenuItem 
                      onClick={() => handleStatusChange('archived')}
                      disabled={isUpdating}
                    >
                      <Archive className="mr-2 h-4 w-4" />
                      {t('actions.archive')}
                    </DropdownMenuItem>
                  )}
                  
                  <DropdownMenuSeparator />
                  
                  <DropdownMenuItem 
                    onClick={handleDelete}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {cycle.type === 'registration' ? t('deleteRegistration', 'Delete Registration') : t('deleteCycle')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent>
        {cycle.description && (
          <div className="text-sm text-muted-foreground mb-4 line-clamp-2 prose prose-sm dark:prose-invert max-w-none [&>*]:m-0" dangerouslySetInnerHTML={{ __html: cycle.description }} />
        )}
        
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{counts.total || 0}</span>
            <span className="text-muted-foreground">{t('stats.applications')}</span>
          </div>
          
          {counts.new > 0 && (
            <Badge variant="secondary" className="text-xs">
              {counts.new} {t('stats.new')}
            </Badge>
          )}
          
          {counts.confirmed > 0 && (
            <Badge variant="outline" className="text-xs bg-green-500/10 text-green-600">
              {counts.confirmed} {t('stats.confirmed')}
            </Badge>
          )}
          
          {cycle.enrollment_deadline && (
            <div className="flex items-center gap-1.5 ml-auto text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span className="text-xs">
                Deadline: {format(new Date(cycle.enrollment_deadline), 'MMM d')}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
