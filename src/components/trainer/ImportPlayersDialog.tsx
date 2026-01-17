import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Upload,
  FileSpreadsheet,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Link2,
} from "lucide-react";
import { GuestPlayer } from "./AddPlayerDialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ImportPlayersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  onPlayersImported: (players: GuestPlayer[]) => void;
}

interface ParsedPlayer {
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  notes: string | null;
  isValid: boolean;
  errors: string[];
  linked_profile_id?: string | null;
  linked_profile_name?: string | null;
}

interface ProfileMatch {
  id: string;
  email: string;
  full_name: string | null;
  skill_rating: number | null;
}

type ImportStep = "upload" | "preview" | "importing" | "complete";

export function ImportPlayersDialog({
  open,
  onOpenChange,
  trainerId,
  onPlayersImported,
}: ImportPlayersDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("upload");
  const [parsedPlayers, setParsedPlayers] = useState<ParsedPlayer[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const resetState = () => {
    setStep("upload");
    setParsedPlayers([]);
    setImportProgress(0);
    setImportedCount(0);
    setFailedCount(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      resetState();
    }
    onOpenChange(isOpen);
  };

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  };

  const parseCSV = (content: string): ParsedPlayer[] => {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    
    if (lines.length < 2) {
      toast({
        title: t("players.import.invalidFile"),
        description: t("players.import.noDataRows"),
        variant: "destructive",
      });
      return [];
    }

    // Parse header to find column indices
    const headerLine = lines[0].toLowerCase();
    const headers = parseCSVLine(headerLine);
    
    const nameIndex = headers.findIndex(h => 
      h.includes("name") || h.includes("naam")
    );
    const emailIndex = headers.findIndex(h => 
      h.includes("email") || h.includes("e-mail")
    );
    const phoneIndex = headers.findIndex(h => 
      h.includes("phone") || h.includes("telefoon") || h.includes("tel")
    );
    const skillIndex = headers.findIndex(h => 
      h.includes("skill") || h.includes("rating") || h.includes("niveau")
    );
    const notesIndex = headers.findIndex(h => 
      h.includes("note") || h.includes("opmerking") || h.includes("notitie")
    );

    if (nameIndex === -1 || emailIndex === -1) {
      toast({
        title: t("players.import.invalidFile"),
        description: t("players.import.missingColumns"),
        variant: "destructive",
      });
      return [];
    }

    const players: ParsedPlayer[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const errors: string[] = [];

      const fullName = values[nameIndex]?.trim() || "";
      const email = values[emailIndex]?.trim() || "";
      const phone = phoneIndex !== -1 ? values[phoneIndex]?.trim() || "" : "";
      const skillRaw = skillIndex !== -1 ? values[skillIndex]?.trim() : null;
      const notes = notesIndex !== -1 ? values[notesIndex]?.trim() || null : null;

      // Validation
      if (!fullName) {
        errors.push(t("players.import.errors.nameMissing"));
      }
      if (!email) {
        errors.push(t("players.import.errors.emailMissing"));
      } else if (!validateEmail(email)) {
        errors.push(t("players.import.errors.emailInvalid"));
      }

      let skillRating: number | null = null;
      if (skillRaw) {
        const parsed = parseFloat(skillRaw.replace(",", "."));
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
          skillRating = parsed;
        } else if (!isNaN(parsed)) {
          errors.push(t("players.import.errors.skillOutOfRange"));
        }
      }

      players.push({
        full_name: fullName,
        email,
        phone,
        skill_rating: skillRating,
        notes,
        isValid: errors.length === 0,
        errors,
      });
    }

    return players;
  };

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if ((char === "," || char === ";") && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    
    return result;
  };

  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith(".csv")) {
      toast({
        title: t("players.import.invalidFile"),
        description: t("players.import.csvOnly"),
        variant: "destructive",
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      const players = parseCSV(content);
      
      if (players.length > 0) {
        // Batch lookup for matching profiles
        const validEmails = players
          .filter(p => p.email && validateEmail(p.email))
          .map(p => p.email.toLowerCase());

        if (validEmails.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("id, email, full_name, skill_rating")
            .in("email", validEmails);

          if (profiles && profiles.length > 0) {
            const profileMap = new Map<string, ProfileMatch>(
              profiles.map(p => [p.email?.toLowerCase() || "", p as ProfileMatch])
            );

            // Update players with linked profile info
            for (const player of players) {
              const matchedProfile = profileMap.get(player.email.toLowerCase());
              if (matchedProfile) {
                player.linked_profile_id = matchedProfile.id;
                player.linked_profile_name = matchedProfile.full_name;
                // Auto-fill skill rating if not provided in CSV
                if (!player.skill_rating && matchedProfile.skill_rating) {
                  player.skill_rating = matchedProfile.skill_rating;
                }
              }
            }
          }
        }

        setParsedPlayers(players);
        setStep("preview");
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleImport = async () => {
    const validPlayers = parsedPlayers.filter(p => p.isValid);
    if (validPlayers.length === 0) return;

    setStep("importing");
    setImportProgress(0);
    
    const imported: GuestPlayer[] = [];
    let failed = 0;

    for (let i = 0; i < validPlayers.length; i++) {
      const player = validPlayers[i];
      
      try {
        const { data, error } = await supabase
          .from("guest_players")
          .insert({
            trainer_id: trainerId,
            full_name: player.full_name,
            email: player.email.toLowerCase(),
            phone: player.phone,
            skill_rating: player.skill_rating,
            notes: player.notes,
            linked_profile_id: player.linked_profile_id || null,
          })
          .select()
          .single();

        if (error) {
          // Handle unique constraint violation (duplicate email)
          if (error.code === "23505") {
            console.warn("Duplicate email skipped:", player.email);
          }
          throw error;
        }
        imported.push(data as GuestPlayer);
      } catch (error) {
        console.error("Failed to import player:", player.email, error);
        failed++;
      }

      setImportProgress(((i + 1) / validPlayers.length) * 100);
    }

    setImportedCount(imported.length);
    setFailedCount(failed);
    setStep("complete");

    if (imported.length > 0) {
      onPlayersImported(imported);
    }
  };

  const downloadTemplate = () => {
    const template = `full_name,email,phone,skill_rating,notes
Jan Jansen,jan@example.com,+31612345678,7.5,Beginner player
Maria de Vries,maria@example.com,+31687654321,5.0,
Piet Pietersen,piet@example.com,+31698765432,,Focus on backhand`;
    
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "players_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const validCount = parsedPlayers.filter(p => p.isValid).length;
  const invalidCount = parsedPlayers.filter(p => !p.isValid).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t("players.import.title")}
          </DialogTitle>
          <DialogDescription>
            {t("players.import.description")}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              className={`
                border-2 border-dashed rounded-lg p-8 text-center transition-colors
                ${isDragging 
                  ? "border-primary bg-primary/5" 
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
                }
              `}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
              <p className="font-medium mb-1">{t("players.import.dropHere")}</p>
              <p className="text-sm text-muted-foreground mb-4">
                {t("players.import.orClickToSelect")}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                {t("players.import.selectFile")}
              </Button>
            </div>

            {/* Template download */}
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
              <div>
                <p className="font-medium text-sm">{t("players.import.needTemplate")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("players.import.templateDescription")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="h-4 w-4 mr-2" />
                {t("players.import.downloadTemplate")}
              </Button>
            </div>

            {/* Format info */}
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">{t("players.import.requiredColumns")}:</p>
              <ul className="list-disc list-inside ml-2">
                <li>full_name / name / naam</li>
                <li>email / e-mail</li>
              </ul>
              <p className="font-medium mt-2">{t("players.import.optionalColumns")}:</p>
              <ul className="list-disc list-inside ml-2">
                <li>phone / telefoon</li>
                <li>skill_rating / rating / niveau (1-10)</li>
                <li>notes / notitie / opmerking</li>
              </ul>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Summary badges */}
            <div className="flex gap-2">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {t("players.import.validRows", { count: validCount })}
              </Badge>
              {invalidCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  {t("players.import.invalidRows", { count: invalidCount })}
                </Badge>
              )}
            </div>

            {/* Preview table */}
            <ScrollArea className="flex-1 border rounded-lg">
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]"></TableHead>
                      <TableHead>{t("players.name")}</TableHead>
                      <TableHead>{t("players.email")}</TableHead>
                      <TableHead>{t("players.phone")}</TableHead>
                      <TableHead>{t("players.skillRating")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedPlayers.map((player, index) => (
                      <TableRow key={index} className={!player.isValid ? "bg-destructive/5" : ""}>
                        <TableCell>
                          {player.isValid ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                          )}
                        </TableCell>
                        <TableCell>
                          <div>
                            <span className="font-medium">{player.full_name || "—"}</span>
                            {player.errors.length > 0 && (
                              <div className="text-xs text-destructive">
                                {player.errors.join(", ")}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span>{player.email || "—"}</span>
                            {player.linked_profile_id && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Link2 className="h-3 w-3 text-green-600 flex-shrink-0" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{t("players.linkedToProfile")}</p>
                                  {player.linked_profile_name && (
                                    <p className="text-xs text-muted-foreground">
                                      {player.linked_profile_name}
                                    </p>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{player.phone || "—"}</TableCell>
                        <TableCell>
                          {player.skill_rating ? player.skill_rating.toFixed(1) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </ScrollArea>

            {/* Actions */}
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={resetState}>
                {t("players.import.chooseAnotherFile")}
              </Button>
              <Button onClick={handleImport} disabled={validCount === 0}>
                {t("players.import.importPlayers", { count: validCount })}
              </Button>
            </div>
          </div>
        )}

        {step === "importing" && (
          <div className="py-8 space-y-4 text-center">
            <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary" />
            <p className="font-medium">{t("players.import.importing")}</p>
            <Progress value={importProgress} className="w-full" />
            <p className="text-sm text-muted-foreground">
              {Math.round(importProgress)}%
            </p>
          </div>
        )}

        {step === "complete" && (
          <div className="py-8 space-y-4 text-center">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-600" />
            <div>
              <p className="font-medium text-lg">{t("players.import.complete")}</p>
              <p className="text-muted-foreground">
                {t("players.import.importedCount", { count: importedCount })}
              </p>
              {failedCount > 0 && (
                <p className="text-sm text-destructive mt-1">
                  {t("players.import.failedCount", { count: failedCount })}
                </p>
              )}
            </div>
            <Button onClick={() => handleClose(false)}>
              {t("common:done")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
