import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataTableCard, compactDataTableClass } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "@/hooks/use-toast";
import {
  Download,
  Trash2,
  ChevronRight,
  Database,
  Clock,
  HardDrive,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";

interface BackupFolder {
  name: string;
  files: { name: string; size: number }[];
  totalSize: number;
  fileCount: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function parseTimestamp(folderName: string): Date | null {
  // Format: 2026-03-30T12-00-00
  const match = folderName.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

export default function AdminBackups() {
  const queryClient = useQueryClient();
  const [deleteFolder, setDeleteFolder] = useState<string | null>(null);
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);

  const { data: backups = [], isLoading } = useQuery<BackupFolder[]>({
    queryKey: ["admin-backups"],
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("backups").list("", {
        limit: 100,
        sortBy: { column: "name", order: "desc" },
      });
      if (error) throw error;

      const folders: BackupFolder[] = [];
      for (const item of data || []) {
        if (!item.name || item.name.startsWith(".")) continue;
        const { data: files } = await supabase.storage
          .from("backups")
          .list(item.name);
        if (files) {
          folders.push({
            name: item.name,
            files: files.map((f) => ({
              name: f.name,
              size: f.metadata?.size || 0,
            })),
            totalSize: files.reduce(
              (s, f) => s + (f.metadata?.size || 0),
              0
            ),
            fileCount: files.length,
          });
        }
      }
      return folders;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (folderName: string) => {
      const { data: files } = await supabase.storage
        .from("backups")
        .list(folderName);
      if (files && files.length > 0) {
        const paths = files.map((f) => `${folderName}/${f.name}`);
        const { error } = await supabase.storage.from("backups").remove(paths);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-backups"] });
      toast({ title: "Backup verwijderd" });
      setDeleteFolder(null);
    },
    onError: () => {
      toast({
        title: "Fout bij verwijderen",
        variant: "destructive",
      });
    },
  });

  const handleDownload = async (folder: string, fileName: string) => {
    const { data, error } = await supabase.storage
      .from("backups")
      .download(`${folder}/${fileName}`);
    if (error || !data) {
      toast({ title: "Download mislukt", variant: "destructive" });
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${folder}_${fileName}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const latestBackup = backups[0];
  const latestDate = latestBackup
    ? parseTimestamp(latestBackup.name)
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Backups</h1>
        <p className="text-muted-foreground">
          Automatische database backups — elke 2 uur, 14 dagen bewaard
        </p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Clock className="h-4 w-4" />
            Laatste backup
          </div>
          <p className="text-lg font-semibold">
            {latestDate
              ? format(latestDate, "dd MMM yyyy HH:mm")
              : "Geen backups"}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Database className="h-4 w-4" />
            Totaal backups
          </div>
          <p className="text-lg font-semibold">{backups.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <HardDrive className="h-4 w-4" />
            Schema
          </div>
          <Badge variant="secondary">Elke 2 uur</Badge>
        </div>
      </div>

      {/* Backup History */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : backups.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          Nog geen backups beschikbaar. De eerste backup wordt automatisch
          aangemaakt.
        </div>
      ) : (
        <DataTableCard desktopOnly={false}>
          <Table className={compactDataTableClass}>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Tabellen</TableHead>
                <TableHead>Grootte</TableHead>
                <TableHead className="w-[100px]">Acties</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((backup) => {
                const date = parseTimestamp(backup.name);
                const isExpanded = expandedFolder === backup.name;
                return (
                  <Collapsible
                    key={backup.name}
                    open={isExpanded}
                    onOpenChange={() =>
                      setExpandedFolder(isExpanded ? null : backup.name)
                    }
                    asChild
                  >
                    <>
                      <TableRow className="cursor-pointer">
                        <TableCell>
                          <CollapsibleTrigger asChild>
                            <button className="flex items-center gap-2 text-left w-full">
                              <ChevronRight
                                className={`h-4 w-4 transition-transform ${
                                  isExpanded ? "rotate-90" : ""
                                }`}
                              />
                              {date
                                ? format(date, "dd MMM yyyy HH:mm")
                                : backup.name}
                            </button>
                          </CollapsibleTrigger>
                        </TableCell>
                        <TableCell>{backup.fileCount} tabellen</TableCell>
                        <TableCell>{formatBytes(backup.totalSize)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteFolder(backup.name);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      <CollapsibleContent asChild>
                        <tr>
                          {/* Escape-hatch exception: the expandable file-list row must grow past the
                              compact 40px clamp so its contents aren't clipped. */}
                          <td colSpan={4} className="p-0 !h-auto !max-h-none !overflow-visible">
                            <div className="bg-muted/30 px-8 py-3 space-y-1">
                              {backup.files.map((file) => (
                                <div
                                  key={file.name}
                                  className="flex items-center justify-between py-1"
                                >
                                  <span className="text-sm font-mono">
                                    {file.name}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs text-muted-foreground">
                                      {formatBytes(file.size)}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="icon" aria-label="Download"
                                      className="h-7 w-7"
                                      onClick={() =>
                                        handleDownload(backup.name, file.name)
                                      }
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      </CollapsibleContent>
                    </>
                  </Collapsible>
                );
              })}
            </TableBody>
          </Table>
        </DataTableCard>
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteFolder}
        onOpenChange={(open) => {
          if (!open) setDeleteFolder(null);
        }}
        title="Backup verwijderen"
        description={
          <>
            Weet je zeker dat je de backup van{" "}
            <strong>
              {deleteFolder
                ? (() => {
                    const d = parseTimestamp(deleteFolder);
                    return d
                      ? format(d, "dd MMM yyyy HH:mm")
                      : deleteFolder;
                  })()
                : ""}
            </strong>{" "}
            wilt verwijderen? Dit kan niet ongedaan worden gemaakt.
          </>
        }
        confirmLabel="Verwijderen"
        cancelLabel="Annuleren"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteFolder) deleteMutation.mutate(deleteFolder);
        }}
      />
    </div>
  );
}
