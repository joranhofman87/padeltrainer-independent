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
} from "lucide-react";

interface ImportLocationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLocationsImported: () => void;
}

interface ParsedLocation {
  name: string;
  city: string;
  country: string;
  street_address: string | null;
  postal_code: string | null;
  website_url: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  opening_hours: string | null;
  indoor_courts: number | null;
  outdoor_courts: number | null;
  description: string | null;
  slug: string;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
}

type ImportStep = "upload" | "preview" | "importing" | "complete";

// Header aliases for flexible column matching
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "naam", "club_name", "clubname"],
  city: ["city", "stad", "plaats"],
  country: ["country", "land"],
  street_address: ["street_address", "address", "straat", "adres", "street"],
  postal_code: ["postal_code", "postcode", "zip", "zipcode"],
  website_url: ["website_url", "website", "url", "domain"],
  latitude: ["latitude", "lat"],
  longitude: ["longitude", "lng", "lon"],
  phone: ["phone", "telefoon", "tel", "telephone"],
  email: ["email", "e-mail", "mail"],
  facebook_url: ["facebook_url", "facebook"],
  instagram_url: ["instagram_url", "instagram"],
  google_maps_url: ["google_maps_url", "google maps url", "maps_url", "google maps"],
  google_rating: ["google_rating", "average rating", "rating", "google_rating_average"],
  google_review_count: ["google_review_count", "review count", "reviews", "review_count"],
  opening_hours: ["opening_hours", "opening hours", "hours", "openingstijden"],
  indoor_courts: ["indoor_courts", "indoor", "indoor courts"],
  outdoor_courts: ["outdoor_courts", "outdoor", "outdoor courts"],
  description: ["description", "beschrijving", "omschrijving"],
};

export function ImportLocationsDialog({
  open,
  onOpenChange,
  onLocationsImported,
}: ImportLocationsDialogProps) {
  const { t } = useTranslation("admin");
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("upload");
  const [parsedLocations, setParsedLocations] = useState<ParsedLocation[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const resetState = () => {
    setStep("upload");
    setParsedLocations([]);
    setImportProgress(0);
    setImportedCount(0);
    setFailedCount(0);
    setSkippedCount(0);
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

  const generateSlug = (name: string, city: string): string => {
    return `${name}-${city}`
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove accents
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  };

  // Haversine formula to calculate distance between two GPS points in meters
  const calculateDistance = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number => {
    const R = 6371000; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  };

  const normalizeCoordinate = (value: string): number | null => {
    if (!value || value.trim() === "") return null;
    
    // Handle comma as decimal separator
    let normalized = value.replace(",", ".");
    
    // Handle malformed coordinates like "40.348.709" -> "40.348709"
    const parts = normalized.split(".");
    if (parts.length > 2) {
      // Keep first part as integer, join rest as decimals
      normalized = parts[0] + "." + parts.slice(1).join("");
    }
    
    const parsed = parseFloat(normalized);
    if (isNaN(parsed)) return null;
    
    // Basic sanity check for lat/long ranges
    if (Math.abs(parsed) > 180) return null;
    
    return parsed;
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

  const findColumnIndex = (headers: string[], fieldName: string): number => {
    const aliases = HEADER_ALIASES[fieldName] || [fieldName];
    return headers.findIndex(h => 
      aliases.some(alias => h.toLowerCase().includes(alias.toLowerCase()))
    );
  };

  const parseCSV = async (content: string): Promise<ParsedLocation[]> => {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    
    if (lines.length < 2) {
      toast({
        title: t("locations.import.invalidFile", "Invalid file"),
        description: t("locations.import.noDataRows", "No data rows found"),
        variant: "destructive",
      });
      return [];
    }

    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine);

    // Find column indices
    const indices: Record<string, number> = {};
    Object.keys(HEADER_ALIASES).forEach(field => {
      indices[field] = findColumnIndex(headers, field);
    });

    if (indices.name === -1 || indices.city === -1) {
      toast({
        title: t("locations.import.invalidFile", "Invalid file"),
        description: t("locations.import.missingColumns", "Missing required columns: name, city"),
        variant: "destructive",
      });
      return [];
    }

    const locations: ParsedLocation[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const errors: string[] = [];

      const name = values[indices.name]?.trim() || "";
      const city = values[indices.city]?.trim() || "";

      // Validation
      if (!name) {
        errors.push(t("locations.import.errors.nameMissing", "Name is required"));
      }
      if (!city) {
        errors.push(t("locations.import.errors.cityMissing", "City is required"));
      }

      const slug = generateSlug(name, city);

      // Parse optional fields
      const country = indices.country !== -1 ? values[indices.country]?.trim() || "NL" : "NL";
      const street_address = indices.street_address !== -1 ? values[indices.street_address]?.trim() || null : null;
      const postal_code = indices.postal_code !== -1 ? values[indices.postal_code]?.trim() || null : null;
      const website_url = indices.website_url !== -1 ? values[indices.website_url]?.trim() || null : null;
      const latitude = indices.latitude !== -1 ? normalizeCoordinate(values[indices.latitude] || "") : null;
      const longitude = indices.longitude !== -1 ? normalizeCoordinate(values[indices.longitude] || "") : null;
      const phone = indices.phone !== -1 ? values[indices.phone]?.trim() || null : null;
      const email = indices.email !== -1 ? values[indices.email]?.trim() || null : null;
      const facebook_url = indices.facebook_url !== -1 ? values[indices.facebook_url]?.trim() || null : null;
      const instagram_url = indices.instagram_url !== -1 ? values[indices.instagram_url]?.trim() || null : null;
      const google_maps_url = indices.google_maps_url !== -1 ? values[indices.google_maps_url]?.trim() || null : null;
      const description = indices.description !== -1 ? values[indices.description]?.trim() || null : null;
      const opening_hours = indices.opening_hours !== -1 ? values[indices.opening_hours]?.trim() || null : null;

      // Parse numeric fields
      let google_rating: number | null = null;
      if (indices.google_rating !== -1 && values[indices.google_rating]) {
        const parsed = parseFloat(values[indices.google_rating].replace(",", "."));
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 5) {
          google_rating = parsed;
        }
      }

      let google_review_count: number | null = null;
      if (indices.google_review_count !== -1 && values[indices.google_review_count]) {
        const parsed = parseInt(values[indices.google_review_count].replace(/\D/g, ""), 10);
        if (!isNaN(parsed)) {
          google_review_count = parsed;
        }
      }

      let indoor_courts: number | null = null;
      if (indices.indoor_courts !== -1 && values[indices.indoor_courts]) {
        const parsed = parseInt(values[indices.indoor_courts], 10);
        if (!isNaN(parsed)) {
          indoor_courts = parsed;
        }
      }

      let outdoor_courts: number | null = null;
      if (indices.outdoor_courts !== -1 && values[indices.outdoor_courts]) {
        const parsed = parseInt(values[indices.outdoor_courts], 10);
        if (!isNaN(parsed)) {
          outdoor_courts = parsed;
        }
      }

      locations.push({
        name,
        city,
        country,
        street_address,
        postal_code,
        website_url,
        latitude,
        longitude,
        phone,
        email,
        facebook_url,
        instagram_url,
        google_maps_url,
        google_rating,
        google_review_count,
        opening_hours,
        indoor_courts,
        outdoor_courts,
        description,
        slug,
        isValid: errors.length === 0,
        isDuplicate: false,
        errors,
      });
    }

    // Fetch existing locations with coordinates for proximity check
    const { data: existingLocations } = await supabase
      .from("locations")
      .select("id, name, city, slug, latitude, longitude")
      .not("latitude", "is", null);

    const existingWithCoords = existingLocations?.filter(
      (loc) => loc.latitude !== null && loc.longitude !== null
    ) || [];

    // Build a set of existing slugs for fallback matching
    const existingSlugs = new Set(existingLocations?.map((loc) => loc.slug) || []);

    const PROXIMITY_THRESHOLD_METERS = 50; // Same venue if < 50m away

    // Check for duplicates: coordinate-based first, then slug fallback
    for (const location of locations) {
      if (!location.isValid || location.isDuplicate) continue;

      // If imported location has coordinates, check proximity
      if (location.latitude !== null && location.longitude !== null) {
        for (const existing of existingWithCoords) {
          const distance = calculateDistance(
            location.latitude,
            location.longitude,
            existing.latitude!,
            existing.longitude!
          );

          if (distance < PROXIMITY_THRESHOLD_METERS) {
            location.isDuplicate = true;
            location.errors.push(
              t("locations.import.errors.nearbyMatch", 
                `Matches "{{name}}" ({{distance}}m away)`, 
                { name: existing.name, distance: Math.round(distance) }
              )
            );
            break;
          }
        }
      } else {
        // Fallback: slug-based check if no coordinates
        if (existingSlugs.has(location.slug)) {
          location.isDuplicate = true;
          location.errors.push(t("locations.import.errors.duplicateSlug", "Already exists (by name)"));
        }
      }
    }

    // Check for duplicates within the file itself (coordinate-based first, then slug)
    const seenCoords: Array<{ lat: number; lng: number; name: string }> = [];
    const seenSlugs = new Set<string>();

    for (const location of locations) {
      if (!location.isValid || location.isDuplicate) continue;

      if (location.latitude !== null && location.longitude !== null) {
        // Check against already-seen coordinates in this file
        for (const seen of seenCoords) {
          const distance = calculateDistance(
            location.latitude,
            location.longitude,
            seen.lat,
            seen.lng
          );
          if (distance < PROXIMITY_THRESHOLD_METERS) {
            location.isDuplicate = true;
            location.errors.push(
              t("locations.import.errors.duplicateInFile", 
                `Duplicate of "{{name}}" in file`, 
                { name: seen.name }
              )
            );
            break;
          }
        }
        if (!location.isDuplicate) {
          seenCoords.push({ lat: location.latitude, lng: location.longitude, name: location.name });
        }
      } else {
        // Fallback: slug check within file
        if (seenSlugs.has(location.slug)) {
          location.isDuplicate = true;
          location.errors.push(t("locations.import.errors.duplicateInFile", "Duplicate in file"));
        } else {
          seenSlugs.add(location.slug);
        }
      }
    }

    return locations;
  };

  const handleFileSelect = async (file: File) => {
    if (!file.name.endsWith(".csv")) {
      toast({
        title: t("locations.import.invalidFile", "Invalid file"),
        description: t("locations.import.csvOnly", "Please select a CSV file"),
        variant: "destructive",
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      const locations = await parseCSV(content);
      
      if (locations.length > 0) {
        setParsedLocations(locations);
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
    const validLocations = parsedLocations.filter(l => l.isValid && !l.isDuplicate);
    if (validLocations.length === 0) return;

    setStep("importing");
    setImportProgress(0);
    
    let imported = 0;
    let failed = 0;
    let skipped = 0;

    const BATCH_SIZE = 100;
    const batches = Math.ceil(validLocations.length / BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, validLocations.length);
      const batch = validLocations.slice(start, end);

      const insertData = batch.map(loc => ({
        name: loc.name,
        city: loc.city,
        country: loc.country,
        street_address: loc.street_address,
        postal_code: loc.postal_code,
        website_url: loc.website_url,
        latitude: loc.latitude,
        longitude: loc.longitude,
        phone: loc.phone,
        email: loc.email,
        facebook_url: loc.facebook_url,
        instagram_url: loc.instagram_url,
        google_maps_url: loc.google_maps_url,
        google_rating: loc.google_rating,
        google_review_count: loc.google_review_count,
        opening_hours: loc.opening_hours,
        indoor_courts: loc.indoor_courts ?? 0,
        outdoor_courts: loc.outdoor_courts ?? 0,
        description: loc.description,
        slug: loc.slug,
        is_active: true,
      }));

      try {
        const { data, error } = await supabase
          .from("locations")
          .insert(insertData)
          .select("id");

        if (error) {
          console.error("Batch insert error:", error);
          // Try individual inserts for this batch
          for (const loc of insertData) {
            try {
              const { error: singleError } = await supabase
                .from("locations")
                .insert(loc);
              
              if (singleError) {
                if (singleError.code === "23505") {
                  skipped++;
                } else {
                  failed++;
                }
              } else {
                imported++;
              }
            } catch {
              failed++;
            }
          }
        } else {
          imported += data?.length || batch.length;
        }
      } catch (error) {
        console.error("Batch error:", error);
        failed += batch.length;
      }

      setImportProgress(((batchIndex + 1) / batches) * 100);
    }

    setImportedCount(imported);
    setFailedCount(failed);
    setSkippedCount(skipped);
    setStep("complete");

    if (imported > 0) {
      onLocationsImported();
    }
  };

  const downloadTemplate = () => {
    const template = `name,street_address,postal_code,city,country,website_url,latitude,longitude,phone,email,facebook_url,instagram_url,indoor_courts,outdoor_courts
Padel Club Amsterdam,Sportlaan 10,1012 AB,Amsterdam,NL,https://padelclubamsterdam.nl,52.3676,4.9041,+31201234567,info@padelclubamsterdam.nl,https://facebook.com/padelclubamsterdam,https://instagram.com/padelclubamsterdam,4,2
TC Rotterdam,Tennisweg 5,3011 XY,Rotterdam,NL,https://tcrotterdam.nl,51.9244,4.4777,,,,,,6,0`;
    
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "locations_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const validCount = parsedLocations.filter(l => l.isValid && !l.isDuplicate).length;
  const invalidCount = parsedLocations.filter(l => !l.isValid).length;
  const duplicateCount = parsedLocations.filter(l => l.isDuplicate).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {t("locations.import.title", "Import Locations")}
          </DialogTitle>
          <DialogDescription>
            {t("locations.import.description", "Bulk import padel clubs from CSV file")}
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
              <p className="font-medium mb-1">{t("locations.import.dropHere", "Drop CSV file here")}</p>
              <p className="text-sm text-muted-foreground mb-4">
                {t("locations.import.orClickToSelect", "or click to select")}
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
                {t("locations.import.selectFile", "Select File")}
              </Button>
            </div>

            {/* Template download */}
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
              <div>
                <p className="font-medium text-sm">{t("locations.import.needTemplate", "Need a template?")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("locations.import.templateDescription", "Download our CSV template with the correct column format")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="h-4 w-4 mr-2" />
                {t("locations.import.downloadTemplate", "Download Template")}
              </Button>
            </div>

            {/* Format info */}
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">{t("locations.import.requiredColumns", "Required columns")}:</p>
              <ul className="list-disc list-inside ml-2">
                <li>name / naam</li>
                <li>city / stad</li>
              </ul>
              <p className="font-medium mt-2">{t("locations.import.optionalColumns", "Optional columns")}:</p>
              <ul className="list-disc list-inside ml-2">
                <li>street_address, postal_code, country, website_url</li>
                <li>latitude, longitude</li>
                <li>phone, email, facebook_url, instagram_url</li>
                <li>indoor_courts, outdoor_courts</li>
                <li>google_rating, google_review_count, opening_hours</li>
              </ul>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Summary badges */}
            <div className="flex gap-2 flex-wrap">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {t("locations.import.validRows", "{{count}} valid", { count: validCount })}
              </Badge>
              {invalidCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  {t("locations.import.invalidRows", "{{count}} invalid", { count: invalidCount })}
                </Badge>
              )}
              {duplicateCount > 0 && (
                <Badge variant="secondary" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {t("locations.import.duplicateRows", "{{count}} duplicates", { count: duplicateCount })}
                </Badge>
              )}
            </div>

            {/* Preview table */}
            <ScrollArea className="flex-1 border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Website</TableHead>
                    <TableHead>Coords</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedLocations.slice(0, 100).map((location, index) => (
                    <TableRow 
                      key={index} 
                      className={
                        !location.isValid ? "bg-destructive/5" : 
                        location.isDuplicate ? "bg-yellow-500/5" : ""
                      }
                    >
                      <TableCell>
                        {location.isValid && !location.isDuplicate ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : location.isDuplicate ? (
                          <AlertTriangle className="h-4 w-4 text-yellow-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          <span className="font-medium">{location.name || "—"}</span>
                          {location.errors.length > 0 && (
                            <div className="text-xs text-destructive">
                              {location.errors.join(", ")}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{location.city || "—"}</TableCell>
                      <TableCell>{location.country || "—"}</TableCell>
                      <TableCell className="max-w-[150px] truncate">
                        {location.website_url || "—"}
                      </TableCell>
                      <TableCell>
                        {location.latitude && location.longitude 
                          ? "✓" 
                          : "—"
                        }
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {parsedLocations.length > 100 && (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  Showing first 100 of {parsedLocations.length} rows
                </div>
              )}
            </ScrollArea>

            {/* Actions */}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("upload")}>
                Back
              </Button>
              <Button 
                onClick={handleImport} 
                disabled={validCount === 0}
              >
                Import {validCount} Locations
              </Button>
            </div>
          </div>
        )}

        {step === "importing" && (
          <div className="py-8 space-y-6">
            <div className="text-center">
              <Loader2 className="h-10 w-10 animate-spin mx-auto text-primary mb-4" />
              <p className="font-medium">{t("locations.import.importing", "Importing locations...")}</p>
              <p className="text-sm text-muted-foreground">
                {Math.round(importProgress)}% complete
              </p>
            </div>
            <Progress value={importProgress} className="h-2" />
          </div>
        )}

        {step === "complete" && (
          <div className="py-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-600" />
            <div>
              <p className="font-medium text-lg">{t("locations.import.complete", "Import Complete")}</p>
              <div className="text-sm text-muted-foreground space-y-1 mt-2">
                <p>{t("locations.import.importedCount", "{{count}} locations imported", { count: importedCount })}</p>
                {failedCount > 0 && (
                  <p className="text-destructive">
                    {t("locations.import.failedCount", "{{count}} failed", { count: failedCount })}
                  </p>
                )}
                {skippedCount > 0 && (
                  <p className="text-yellow-600">
                    {t("locations.import.skippedCount", "{{count}} skipped (duplicates)", { count: skippedCount })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={resetState}>
                Import More
              </Button>
              <Button onClick={() => handleClose(false)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
