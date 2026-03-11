import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export interface Certification {
  id: string;
  name: string;
  country: string;
  description: string | null;
  is_active: boolean;
  display_order: number;
  created_at: string;
}

export interface Specialization {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  display_order: number;
  created_at: string;
}

// Country display info
export const COUNTRIES: Record<string, { name: string; flag: string }> = {
  'NL': { name: 'Netherlands', flag: '🇳🇱' },
  'BE': { name: 'Belgium', flag: '🇧🇪' },
  'ES': { name: 'Spain', flag: '🇪🇸' },
  'DE': { name: 'Germany', flag: '🇩🇪' },
  'FR': { name: 'France', flag: '🇫🇷' },
  'UK': { name: 'United Kingdom', flag: '🇬🇧' },
  'INT': { name: 'International', flag: '🌍' },
};

export function getCountryInfo(countryCode: string) {
  return COUNTRIES[countryCode] || { name: countryCode, flag: '🏳️' };
}

// Fetch all active certifications
export async function getCertifications(): Promise<Certification[]> {
  const { data, error } = await supabase
    .from('certifications')
    .select('*')
    .eq('is_active', true)
    .order('country')
    .order('display_order');
  
  if (error) {
    logger.error('Error fetching certifications', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    return [];
  }
  
  return data || [];
}

// Fetch all certifications (for admin)
export async function getAllCertifications(): Promise<Certification[]> {
  const { data, error } = await supabase
    .from('certifications')
    .select('*')
    .order('country')
    .order('display_order');
  
  if (error) {
    logger.error('Error fetching all certifications', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    return [];
  }
  
  return data || [];
}

// Fetch certifications by country
export async function getCertificationsByCountry(country: string): Promise<Certification[]> {
  const { data, error } = await supabase
    .from('certifications')
    .select('*')
    .eq('country', country)
    .eq('is_active', true)
    .order('display_order');
  
  if (error) {
    logger.error('Error fetching certifications by country', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    return [];
  }
  
  return data || [];
}

// Group certifications by country
export function groupCertificationsByCountry(
  certifications: Certification[],
  priorityCountry?: string
): Map<string, Certification[]> {
  const grouped = new Map<string, Certification[]>();
  
  // First, group all certifications
  certifications.forEach(cert => {
    const existing = grouped.get(cert.country) || [];
    existing.push(cert);
    grouped.set(cert.country, existing);
  });
  
  // If priority country is set, reorder the map
  if (priorityCountry && grouped.has(priorityCountry)) {
    const orderedMap = new Map<string, Certification[]>();
    
    // Priority country first
    orderedMap.set(priorityCountry, grouped.get(priorityCountry)!);
    
    // International second
    if (priorityCountry !== 'INT' && grouped.has('INT')) {
      orderedMap.set('INT', grouped.get('INT')!);
    }
    
    // Then alphabetically by country name
    const sortedCountries = Array.from(grouped.keys())
      .filter(c => c !== priorityCountry && c !== 'INT')
      .sort((a, b) => getCountryInfo(a).name.localeCompare(getCountryInfo(b).name));
    
    sortedCountries.forEach(country => {
      orderedMap.set(country, grouped.get(country)!);
    });
    
    return orderedMap;
  }
  
  return grouped;
}

// Fetch all active specializations
export async function getSpecializations(): Promise<Specialization[]> {
  const { data, error } = await supabase
    .from('specializations')
    .select('*')
    .eq('is_active', true)
    .order('display_order');
  
  if (error) {
    logger.error('Error fetching specializations', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    return [];
  }
  
  return data || [];
}

// Fetch all specializations (for admin)
export async function getAllSpecializations(): Promise<Specialization[]> {
  const { data, error } = await supabase
    .from('specializations')
    .select('*')
    .order('display_order');
  
  if (error) {
    logger.error('Error fetching all specializations', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    return [];
  }
  
  return data || [];
}

// Admin: Create certification
export async function createCertification(
  name: string,
  country: string,
  description?: string
): Promise<Certification | null> {
  const { data, error } = await supabase
    .from('certifications')
    .insert({ name, country, description })
    .select()
    .single();
  
  if (error) {
    logger.error('Error creating certification', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    throw error;
  }
  
  return data;
}

// Admin: Update certification
export async function updateCertification(
  id: string,
  updates: Partial<Pick<Certification, 'name' | 'description' | 'is_active' | 'display_order' | 'country'>>
): Promise<Certification | null> {
  const { data, error } = await supabase
    .from('certifications')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    logger.error('Error updating certification', error instanceof Error ? error : new Error(String(error)), { component: 'certifications' });
    throw error;
  }
  
  return data;
}

// Admin: Delete certification
export async function deleteCertification(id: string): Promise<void> {
  const { error } = await supabase
    .from('certifications')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting certification:', error);
    throw error;
  }
}

// Admin: Create specialization
export async function createSpecialization(
  name: string,
  description?: string
): Promise<Specialization | null> {
  const { data, error } = await supabase
    .from('specializations')
    .insert({ name, description })
    .select()
    .single();
  
  if (error) {
    console.error('Error creating specialization:', error);
    throw error;
  }
  
  return data;
}

// Admin: Update specialization
export async function updateSpecialization(
  id: string,
  updates: Partial<Pick<Specialization, 'name' | 'description' | 'is_active' | 'display_order'>>
): Promise<Specialization | null> {
  const { data, error } = await supabase
    .from('specializations')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  
  if (error) {
    console.error('Error updating specialization:', error);
    throw error;
  }
  
  return data;
}

// Admin: Delete specialization
export async function deleteSpecialization(id: string): Promise<void> {
  const { error } = await supabase
    .from('specializations')
    .delete()
    .eq('id', id);
  
  if (error) {
    console.error('Error deleting specialization:', error);
    throw error;
  }
}

// Get trainer's country from their primary location
export async function getTrainerCountry(userId: string): Promise<string> {
  // First get trainer profile id
  const { data: trainer } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .single();
  
  if (!trainer) return 'NL';
  
  // Get first location's country
  const { data: locationData } = await supabase
    .from('trainer_locations')
    .select('locations(country)')
    .eq('trainer_id', trainer.id)
    .limit(1)
    .single();
  
  if (locationData?.locations) {
    const loc = locationData.locations as unknown as { country: string };
    return loc.country || 'NL';
  }
  
  return 'NL';
}
