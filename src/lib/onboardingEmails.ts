import { supabase } from "@/integrations/supabase/client";

export type UserType = "player" | "trainer" | "club" | "academy";
export type TriggerType = "signup" | "paid_plan";
export type EmailStatus = "pending" | "sent" | "failed" | "cancelled";

export interface OnboardingEmailTemplate {
  id: string;
  name: string;
  user_type: UserType;
  trigger_type: TriggerType;
  delay_days: number;
  subject: string;
  body_html: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OnboardingEmailQueue {
  id: string;
  template_id: string;
  user_id: string;
  email: string;
  user_name: string;
  user_type: string;
  scheduled_for: string;
  sent_at: string | null;
  status: EmailStatus;
  error_message: string | null;
  created_at: string;
  template?: OnboardingEmailTemplate;
}

export interface OnboardingEmailLog {
  id: string;
  template_id: string;
  queue_id: string | null;
  user_id: string;
  email: string;
  subject: string;
  sent_at: string;
  status: "sent" | "failed";
}

export interface CreateTemplateInput {
  name: string;
  user_type: UserType;
  trigger_type: TriggerType;
  delay_days: number;
  subject: string;
  body_html: string;
  is_active?: boolean;
}

export interface UpdateTemplateInput extends Partial<CreateTemplateInput> {
  id: string;
}

// Fetch all templates
export async function fetchOnboardingTemplates(): Promise<OnboardingEmailTemplate[]> {
  const { data, error } = await supabase
    .from("onboarding_email_templates")
    .select("*")
    .order("user_type")
    .order("trigger_type")
    .order("delay_days");

  if (error) throw error;
  return data as OnboardingEmailTemplate[];
}

// Create a new template
export async function createOnboardingTemplate(
  input: CreateTemplateInput
): Promise<OnboardingEmailTemplate> {
  const { data, error } = await supabase
    .from("onboarding_email_templates")
    .insert({
      name: input.name,
      user_type: input.user_type,
      trigger_type: input.trigger_type,
      delay_days: input.delay_days,
      subject: input.subject,
      body_html: input.body_html,
      is_active: input.is_active ?? true,
    })
    .select()
    .single();

  if (error) throw error;
  return data as OnboardingEmailTemplate;
}

// Update an existing template
export async function updateOnboardingTemplate(
  input: UpdateTemplateInput
): Promise<OnboardingEmailTemplate> {
  const { id, ...updates } = input;
  const { data, error } = await supabase
    .from("onboarding_email_templates")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as OnboardingEmailTemplate;
}

// Delete a template
export async function deleteOnboardingTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from("onboarding_email_templates")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

// Toggle template active status
export async function toggleTemplateActive(
  id: string,
  is_active: boolean
): Promise<OnboardingEmailTemplate> {
  return updateOnboardingTemplate({ id, is_active });
}

// Fetch email queue (for monitoring)
export async function fetchEmailQueue(
  status?: EmailStatus
): Promise<OnboardingEmailQueue[]> {
  let query = supabase
    .from("onboarding_email_queue")
    .select(`
      *,
      template:onboarding_email_templates(*)
    `)
    .order("scheduled_for", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data as OnboardingEmailQueue[];
}

// Fetch email logs (for audit)
export async function fetchEmailLogs(limit = 100): Promise<OnboardingEmailLog[]> {
  const { data, error } = await supabase
    .from("onboarding_email_logs")
    .select("*")
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data as OnboardingEmailLog[];
}

// Cancel a pending email
export async function cancelQueuedEmail(id: string): Promise<void> {
  const { error } = await supabase
    .from("onboarding_email_queue")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("status", "pending");

  if (error) throw error;
}

// Send a test email
export async function sendTestEmail(
  templateId: string,
  testEmail: string
): Promise<{ success: boolean; error?: string }> {
  const { data: session } = await supabase.auth.getSession();
  
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-onboarding-emails`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.session?.access_token}`,
      },
      body: JSON.stringify({
        test_mode: true,
        template_id: templateId,
        test_email: testEmail,
      }),
    }
  );

  const result = await response.json();
  
  if (!response.ok) {
    return { success: false, error: result.error || "Failed to send test email" };
  }
  
  return { success: true };
}

// Template variable placeholders for reference
export const TEMPLATE_VARIABLES = [
  { key: "{{user_name}}", description: "Recipient's full name" },
  { key: "{{user_email}}", description: "Recipient's email address" },
  { key: "{{user_type}}", description: "User type (Player, Trainer, Club, Academy)" },
  { key: "{{signup_date}}", description: "Date the user signed up" },
  { key: "{{plan_name}}", description: "Subscription plan name (for paid_plan trigger)" },
];
