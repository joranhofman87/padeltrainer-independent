import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Loader2, Users, Clock, ArrowRight, Star } from 'lucide-react';
import {
  type SlotWithOccupancy,
  getAvailableSlotsForCycle,
  updateProposedAssignment,
} from '@/lib/cycles';

interface ReassignPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assignmentId: string;
  currentSlotId: string;
  cycleId: string;
  playerName: string;
  onReassigned?: () => void;
}

export default function ReassignPlayerDialog({
  open,
  onOpenChange,
  assignmentId,
  currentSlotId,
  cycleId,
  playerName,
  onReassigned,
}: ReassignPlayerDialogProps) {
  const { t } = useTranslation('cycles');
  const [slots, setSlots] = useState<SlotWithOccupancy[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedSlotId(null);
      return;
    }

    const fetchSlots = async () => {
      setIsLoading(true);
      try {
        const data = await getAvailableSlotsForCycle(cycleId);
        setSlots(data);
      } catch (error) {
        console.error('Error fetching slots:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSlots();
  }, [open, cycleId]);

  const handleMove = async () => {
    if (!selectedSlotId) return;

    const targetSlot = slots.find(s => s.id === selectedSlotId);
    if (!targetSlot) return;

    setIsSubmitting(true);
    try {
      await updateProposedAssignment(assignmentId, {
        slot_id: selectedSlotId,
        trainer_id: targetSlot.trainer_id,
        confidence_score: null,
        rationale: [{ type: 'manual_override', score: 0, detail: `Manually reassigned by manager` }],
      });
      toast.success(t('proposals.reassign.success', { name: playerName }));
      onReassigned?.();
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentSlot = slots.find(s => s.id === currentSlotId);
  const otherSlots = slots.filter(s => s.id !== currentSlotId);

  const formatSlotTime = (slot: SlotWithOccupancy) => {
    const start = new Date(slot.start_time);
    const end = new Date(slot.end_time);
    return `${format(start, 'EEE d MMM')} · ${format(start, 'HH:mm')} - ${format(end, 'HH:mm')}`;
  };

  const getCapacity = (slot: SlotWithOccupancy) => {
    const current = slot.current_assignments.length;
    const max = slot.max_participants || '∞';
    return `${current}/${max}`;
  };

  const isFull = (slot: SlotWithOccupancy) => {
    return slot.max_participants != null && slot.current_assignments.length >= slot.max_participants;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRight className="h-5 w-5" />
            {t('proposals.reassign.title', { name: playerName })}
          </DialogTitle>
          <DialogDescription>
            {t('proposals.reassign.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Current assignment */}
        {currentSlot && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t('proposals.reassign.current')}</p>
            <p className="text-sm font-medium">{formatSlotTime(currentSlot)}</p>
            <p className="text-xs text-muted-foreground">{currentSlot.trainer_name}</p>
            {currentSlot.current_assignments.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {currentSlot.current_assignments.map(a => (
                  <Badge key={a.id} variant="secondary" className="text-xs">
                    {a.player_name}
                    {a.player_rating != null && (
                      <span className="ml-1 opacity-70">{a.player_rating}</span>
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Available slots */}
        <ScrollArea className="max-h-[350px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : otherSlots.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('proposals.reassign.noSlots')}
            </p>
          ) : (
            <RadioGroup value={selectedSlotId || ''} onValueChange={setSelectedSlotId}>
              <div className="space-y-2">
                {otherSlots.map(slot => {
                  const full = isFull(slot);
                  return (
                    <Label
                      key={slot.id}
                      htmlFor={`slot-${slot.id}`}
                      className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors hover:bg-accent/50 ${
                        selectedSlotId === slot.id ? 'border-primary bg-primary/5' : ''
                      } ${full ? 'opacity-60' : ''}`}
                    >
                      <RadioGroupItem
                        value={slot.id}
                        id={`slot-${slot.id}`}
                        className="mt-0.5"
                        disabled={full}
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm font-medium">{formatSlotTime(slot)}</span>
                          </div>
                          <Badge variant={full ? 'destructive' : 'outline'} className="text-xs shrink-0">
                            <Users className="h-3 w-3 mr-1" />
                            {getCapacity(slot)}
                          </Badge>
                        </div>

                        <div className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={slot.trainer_avatar || undefined} />
                            <AvatarFallback className="text-[10px]">
                              {slot.trainer_name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-xs text-muted-foreground">{slot.trainer_name}</span>
                          {slot.cyclus_name && (
                            <span className="text-xs text-muted-foreground">· {slot.cyclus_name}</span>
                          )}
                        </div>

                        {slot.current_assignments.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {slot.current_assignments.map(a => (
                              <Badge key={a.id} variant="secondary" className="text-xs font-normal">
                                {a.player_name}
                                {a.player_rating != null && (
                                  <span className="ml-1 flex items-center gap-0.5 opacity-70">
                                    <Star className="h-2.5 w-2.5" />
                                    {a.player_rating}
                                  </span>
                                )}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </Label>
                  );
                })}
              </div>
            </RadioGroup>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('proposals.confirmDialog.cancel')}
          </Button>
          <Button
            onClick={handleMove}
            disabled={!selectedSlotId || isSubmitting}
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {t('proposals.reassign.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
