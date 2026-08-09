import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import {
  parseImportedPlayersCsv,
  type CsvFatalReason,
  type CsvRowError,
  type ParsedImportPlayer,
} from "@/lib/importPlayersCsv";
import { logger } from "@/lib/logger";
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
} from "lucide-react";
import { GuestPlayer } from "./AddPlayerDialog";
import { TooltipProvider } from "@/components/ui/tooltip";

interface ImportPlayersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId?: string;
  academyId?: string;
  onPlayersImported: (players: GuestPlayer[]) => void;
}

type ImportStep = "upload" | "preview" | "importing" | "complete";

export function ImportPlayersDialog({
  open,
  onOpenChange,
  trainerId,
  academyId,
  onPlayersImported,
}: ImportPlayersDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("upload");
  const [parsedPlayers, setParsedPlayers] = useState<ParsedImportPlayer[]>([]);
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

  /** Error codes carry no language; the dialog is where they become sentences. */
  const FATAL_MESSAGE: Record<CsvFatalReason, string> = {
    no_data_rows: t("players.import.noDataRows"),
    missing_name_column: t("players.import.missingColumns"),
  };
  const ROW_MESSAGE: Record<CsvRowError, string> = {
    name_missing: t("players.import.errors.nameMissing"),
    email_invalid: t("players.import.errors.emailInvalid"),
    skill_out_of_range: t("players.import.errors.skillOutOfRange"),
  };

  const parseCSV = (content: string): ParsedImportPlayer[] => {
    const result = parseImportedPlayersCsv(content);
    if (!result.ok) {
      toast({
        title: t("players.import.invalidFile"),
        description: FATAL_MESSAGE[result.reason],
        variant: "destructive",
      });
      return [];
    }
    return result.players;
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
        // FAM-02 (Batch 4, Level 1): imported players are DISTINCT people — we no longer look up
        // matching profiles to auto-link or inherit their rating (a shared family email would
        // otherwise copy a parent's rating onto a child). Genuine same-person dupes are merged later.
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
        // Through the one create command, not a direct insert: each row is idempotent on its own
        // attempt id, the scope is authorized in one place, and a row that looks like a Player the
        // academy already has files a proposal for a human instead of silently doubling them.
        const { data: created, error } = await supabase.rpc("player_create_command", {
          _creation_request_id: player.creationRequestId,
          _owner_type: academyId ? "academy" : "trainer",
          _owner_id: academyId || trainerId || null,
          _full_name: player.full_name,
          // already normalized (trimmed, lowercased) or NULL by the parser — a Player is not
          // required to have an address, and '' would be a value a matcher could match on
          _email: player.email,
          _phone: player.phone || null,
          _first_name: player.first_name,
          _last_name: player.last_name,
          _skill_rating: player.skill_rating,
          _notes: player.notes,
          _source: "csv_import",
        });
        if (error) throw error;

        const guestPlayerId = (created as { guest_player_id: string | null } | null)?.guest_player_id;
        if (!guestPlayerId) throw new Error("player_create_no_player");
        const { data, error: readError } = await supabase
          .from("guest_players")
          .select("*")
          .eq("id", guestPlayerId)
          .single();
        if (readError) throw readError;
        imported.push(data as GuestPlayer);
      } catch (error) {
        logger.error("Failed to import player", error instanceof Error ? error : new Error(String(error)), { component: 'ImportPlayersDialog', email: player.email });
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
    const template = `first_name,last_name,email,phone,skill_rating,notes
Jan,Jansen,jan@example.com,+31612345678,7.5,Beginner player
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
                <li>{t("players.import.preferredColumns")}</li>
              </ul>
              <p className="font-medium mt-2">{t("players.import.legacyColumns")}:</p>
              <ul className="list-disc list-inside ml-2">
                <li>{t("players.import.legacyNameColumn")}</li>
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
                      <TableHead>{t("players.firstName")}</TableHead>
                      <TableHead>{t("players.lastName")}</TableHead>
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
                          <span className="font-medium">{player.first_name || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">{player.last_name || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <div>
                            {player.errors.length > 0 && (
                              <div className="text-xs text-destructive">
                                {player.errors.map((e) => ROW_MESSAGE[e]).join(", ")}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span>{player.email || "—"}</span>
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
