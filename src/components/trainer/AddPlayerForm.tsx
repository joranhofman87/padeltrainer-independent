import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { buildGuestPlayerDbFields } from "@/lib/profileName";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2, PartyPopper } from "lucide-react";
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from "@/lib/ratingSystems";
import type { GuestPlayer } from "./AddPlayerDialog";

interface AddPlayerFormProps {
  trainerId?: string;
  academyId?: string;
  onPlayerCreated?: (player: GuestPlayer) => void;
  /** If true, show Cancel button */
  showCancel?: boolean;
  onCancel?: () => void;
}

interface LinkedProfile {
  id: string;
  full_name: string | null;
  skill_rating: number | null;
  rating_system?: string;
}

export function AddPlayerForm({
  trainerId,
  academyId,
  onPlayerCreated,
  showCancel,
  onCancel,
}: AddPlayerFormProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [ratingSystem, setRatingSystem] = useState<string>("knltb");
  const [skillRating, setSkillRating] = useState("");
  const [notes, setNotes] = useState("");
  const [linkedProfile, setLinkedProfile] = useState<LinkedProfile | null>(null);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [loadingRatingSystems, setLoadingRatingSystems] = useState(true);
  const [showSuccess, setShowSuccess] = useState(false);
  const [lastCreatedName, setLastCreatedName] = useState("");
  // Shared-email confirm step (families may share one address).
  const [sharedEmailConfirmOpen, setSharedEmailConfirmOpen] = useState(false);
  const [sharedEmailNames, setSharedEmailNames] = useState<string[]>([]);

  useEffect(() => {
    async function fetchRatingSystems() {
      setLoadingRatingSystems(true);
      try {
        const systems = await getRatingSystems();
        setRatingSystems(systems);
        if (systems.length > 0 && !systems.find(s => s.code === ratingSystem)) {
          setRatingSystem(systems[0].code);
        }
      } catch (error) {
        logger.error('Error fetching rating systems', error as Error, { component: 'AddPlayerForm' });
      } finally {
        setLoadingRatingSystems(false);
      }
    }
    fetchRatingSystems();
  }, []);

  const currentRatingSystem = ratingSystems.find(s => s.code === ratingSystem);

  const resetForm = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setRatingSystem("knltb");
    setSkillRating("");
    setNotes("");
    setLinkedProfile(null);
  };

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  };

  const handleEmailBlur = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !validateEmail(trimmedEmail)) {
      setLinkedProfile(null);
      return;
    }

    setIsCheckingEmail(true);
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, skill_rating, rating_system")
        .eq("email", trimmedEmail)
        .maybeSingle();

      if (data) {
        setLinkedProfile(data);
        if (!skillRating && data.skill_rating) {
          const profileRatingSystem = data.rating_system || "knltb";
          setRatingSystem(profileRatingSystem);
          setSkillRating(data.skill_rating.toString());
          const systemConfig = ratingSystems.find(s => s.code === profileRatingSystem);
          toast({
            title: t("players.autoFilledFromProfile"),
            description: `${t("players.skillRating")}: ${data.skill_rating.toFixed(1)} (${systemConfig?.name || profileRatingSystem.toUpperCase()})`,
          });
        }
      } else {
        setLinkedProfile(null);
      }
    } catch (error) {
      logger.warn('Error checking email', { error, component: 'AddPlayerForm' });
      setLinkedProfile(null);
    } finally {
      setIsCheckingEmail(false);
    }
  };

  /**
   * Same-scope guests already using this email. Shared emails are allowed
   * (the unique indexes were dropped), so this only powers a confirm step.
   * Returns [] on lookup errors — the guard rail must never block creation.
   */
  const findSameScopeGuestNamesByEmail = async (trimmedEmail: string): Promise<string[]> => {
    if (!trimmedEmail || (!trainerId && !academyId)) return [];
    try {
      let query = supabase
        .from("guest_players")
        .select("full_name")
        .eq("email", trimmedEmail)
        .limit(3);
      query = trainerId
        ? query.eq("trainer_id", trainerId)
        : query.eq("academy_profile_id", academyId as string);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((row) => row.full_name).filter((name): name is string => Boolean(name));
    } catch (error) {
      logger.warn("Shared-email pre-check failed", { error, component: "AddPlayerForm" });
      return [];
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameFields = buildGuestPlayerDbFields(firstName, lastName);
    if (!nameFields.full_name) {
      toast({
        title: t("common:error"),
        description: t("players.firstName") + " *",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    const existingNames = await findSameScopeGuestNamesByEmail(email.trim().toLowerCase());
    if (existingNames.length > 0) {
      // Shared email: ask before creating a separate player (e.g. a family member).
      setSharedEmailNames(existingNames);
      setSharedEmailConfirmOpen(true);
      setIsLoading(false);
      return;
    }

    await performInsert();
  };

  const performInsert = async () => {
    const nameFields = buildGuestPlayerDbFields(firstName, lastName);
    if (!nameFields.full_name) return;

    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("guest_players")
        .insert({
          trainer_id: trainerId || null,
          academy_profile_id: academyId || null,
          ...nameFields,
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          skill_rating: skillRating ? parseFloat(skillRating) : null,
          rating_system: ratingSystem,
          notes: notes.trim() || null,
          linked_profile_id: linkedProfile?.id || null,
        } as any)
        .select()
        .single();

      if (error) {
        // Harmless fallback: the unique email indexes were dropped (shared
        // emails are allowed), so 23505 only fires on environments that have
        // not run that migration yet.
        if (error.code === "23505") {
          toast({
            title: t("players.duplicateEmail"),
            description: t("players.duplicateEmailDescription"),
            variant: "destructive",
          });
          return;
        }
        throw error;
      }

      setLastCreatedName(nameFields.full_name);
      setShowSuccess(true);
      resetForm();
      onPlayerCreated?.(data as GuestPlayer);
    } catch (error: any) {
      logger.error('Error creating player', error as Error, { component: 'AddPlayerForm' });
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("players.createError", "Could not add the player. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const groupedSystems = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
        <PartyPopper className="h-12 w-12 text-primary" />
        <div>
          <h3 className="text-lg font-semibold">{t("players.playerCreated")}</h3>
          <p className="text-muted-foreground text-sm mt-1">
            {t("players.playerCreatedDescription", { name: lastCreatedName })}
          </p>
        </div>
        <Button onClick={() => setShowSuccess(false)}>
          {t("players.addAnother", "Add another player")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <AlertDialog open={sharedEmailConfirmOpen} onOpenChange={setSharedEmailConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("players.sharedEmail.title", "Email already in use")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "players.sharedEmail.description",
                "{{names}} already use(s) this email. Create a separate player with the same email anyway (e.g. a family member)?",
                { names: sharedEmailNames.join(", ") },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="shared-email-confirm"
              disabled={isLoading}
              onClick={(e) => {
                e.preventDefault();
                setSharedEmailConfirmOpen(false);
                void performInsert();
              }}
            >
              {t("players.sharedEmail.confirm", "Create separate player")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="guest-firstName">{t("players.firstName")} *</Label>
          <Input
            id="guest-firstName"
            name="firstName"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder={t("players.firstNamePlaceholder")}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="guest-lastName">{t("players.lastName")}</Label>
          <Input
            id="guest-lastName"
            name="lastName"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder={t("players.lastNamePlaceholder")}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">{t("players.email")}</Label>
        <div className="relative">
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setLinkedProfile(null);
            }}
            onBlur={handleEmailBlur}
            placeholder={t("players.emailPlaceholder")}
          />
          {isCheckingEmail && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        {linkedProfile && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-sm">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            <div>
              <span className="font-medium">{t("players.linkedToProfile")}</span>
              {linkedProfile.full_name && (
                <span className="ml-1">"{linkedProfile.full_name}"</span>
              )}
              {linkedProfile.skill_rating && (
                <span className="text-green-600 dark:text-green-400 ml-1">
                  • {t("players.skillRating")}: {linkedProfile.skill_rating.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">{t("players.phone")}</Label>
        <Input
          id="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t("players.phonePlaceholder")}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="skillRating">{t("players.skillRating")}</Label>
        <div className="flex items-center gap-2">
          <Select
            value={ratingSystem}
            onValueChange={(value) => {
              setRatingSystem(value);
              setSkillRating("");
            }}
            disabled={loadingRatingSystems}
          >
            <SelectTrigger className="w-36 shrink-0">
              <SelectValue placeholder={loadingRatingSystems ? "Loading..." : "Select"} />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(groupedSystems).map(([country, systems]) => (
                <div key={country}>
                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                    {COUNTRY_NAMES[country] || country}
                  </div>
                  {systems.map((system) => (
                    <SelectItem key={system.code} value={system.code}>
                      {system.name}
                    </SelectItem>
                  ))}
                </div>
              ))}
            </SelectContent>
          </Select>
          <Input
            id="skillRating"
            type="number"
            step={currentRatingSystem?.step || 0.1}
            min={currentRatingSystem?.min_rating || 0.1}
            max={currentRatingSystem?.max_rating || 10}
            value={skillRating}
            onChange={(e) => setSkillRating(e.target.value)}
            placeholder={currentRatingSystem ? `${currentRatingSystem.min_rating} - ${currentRatingSystem.max_rating}` : ""}
            className="flex-1"
            disabled={!currentRatingSystem}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">{t("players.notes")}</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("players.notesPlaceholder")}
          rows={3}
        />
      </div>

      <div className="flex justify-end gap-2 pt-4">
        {showCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
            {t("common:cancel")}
          </Button>
        )}
        <Button type="submit" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("players.addPlayer")}
        </Button>
      </div>
    </form>
    </>
  );
}

/** Build guest_players insert payload (exported for tests). */
export function buildAddPlayerInsertPayload(args: {
  firstName: string;
  lastName: string;
  trainerId?: string;
  academyId?: string;
  email?: string;
  phone?: string;
  skillRating?: string;
  ratingSystem?: string;
  notes?: string;
  linkedProfileId?: string | null;
}) {
  const nameFields = buildGuestPlayerDbFields(args.firstName, args.lastName);
  return {
    trainer_id: args.trainerId || null,
    academy_profile_id: args.academyId || null,
    ...nameFields,
    email: args.email?.trim().toLowerCase() || null,
    phone: args.phone?.trim() || null,
    skill_rating: args.skillRating ? parseFloat(args.skillRating) : null,
    rating_system: args.ratingSystem ?? "knltb",
    notes: args.notes?.trim() || null,
    linked_profile_id: args.linkedProfileId || null,
  };
}
