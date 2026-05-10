import { useTranslation } from 'react-i18next';
import { InvoiceSettingsCardBase, type InvoiceSettingsLabels } from '@/components/invoices/InvoiceSettingsCardBase';

interface InvoiceSettingsCardProps {
  userId: string;
  /**
   * Optional. Kept for backwards compatibility — the shared base
   * self-loads from `trainer_profiles`, so this is ignored.
   */
  initialData?: unknown;
  onSave?: () => void;
}

export function InvoiceSettingsCard({ userId, onSave }: InvoiceSettingsCardProps) {
  const { t } = useTranslation('trainer');

  const labels: InvoiceSettingsLabels = {
    title: t('invoices.settings', 'Factuur Instellingen'),
    description: t('invoices.settingsDescription', 'Bedrijfsgegevens voor je facturen'),
    complete: t('invoices.complete'),
    saved: t('invoices.saved'),
    saveError: t('invoices.saveError'),
    saving: t('invoices.saving'),
    save: t('invoices.saveSettings'),
    logo: t('invoices.logo', 'Factuurlogo'),
    logoDescription: t('invoices.logoDescription', 'Dit logo wordt getoond op je facturen.'),
    noLogo: t('invoices.noLogo', 'Geen logo'),
    uploadLogo: t('invoices.uploadLogo', 'Upload logo'),
    bannerColor: t('invoices.bannerColor', 'Banner color'),
    bannerColorDescription: t('invoices.bannerColorDescription', 'Optional accent color shown behind the logo at the top of your invoices.'),
    noColor: t('invoices.noColor', 'None'),
    customColor: t('invoices.customColor', 'Custom'),
    businessName: t('invoices.businessName', 'Bedrijfsnaam'),
    businessNamePlaceholder: 'Jouw Bedrijf B.V.',
    kvkNumber: t('invoices.kvkNumber', 'KvK-nummer'),
    businessAddress: t('invoices.businessAddress', 'Bedrijfsadres'),
    btwNumber: t('invoices.btwNumber', 'BTW-nummer'),
    korNote: t('invoices.korNote'),
    paymentTerms: t('invoices.paymentTerms', 'Betalingstermijn'),
    days7: t('invoices.days7'),
    days14: t('invoices.days14'),
    days30: t('invoices.days30'),
    defaultVatRate: t('invoices.defaultVatRate', 'Standaard BTW-tarief'),
    vatStandard: t('invoices.vatStandard', 'Standaard tarief'),
    vatReduced: t('invoices.vatReduced', 'Laag tarief'),
    vatExempt: t('invoices.vatExempt', 'Vrijgesteld / KOR'),
    vatCustom: t('invoices.vatCustom', 'Anders...'),
    customVatRate: t('invoices.customVatRate', 'BTW-percentage'),
    vatInclusiveNote: t('invoices.vatInclusiveNote', 'Lesprijzen zijn inclusief BTW. Dit tarief wordt gebruikt voor automatische facturen.'),
    domesticNote: t('invoices.domesticNote'),
    numbering: t('invoices.numbering', 'Factuurnummering'),
    prefix: t('invoices.prefix', 'Prefix'),
    nextNumber: t('invoices.nextNumber', 'Volgend nummer'),
    includeYear: t('invoices.includeYear', 'Jaar opnemen in factuurnummer'),
    previewNumber: t('invoices.previewNumber', 'Voorbeeld'),
    replyToEmail: t('invoices.replyToEmail', 'Reply-to email for invoices'),
    replyToEmailDescription: t('invoices.replyToEmailDescription', 'When a player replies to an invoice email, the reply will be sent to this address. If left empty, your account email is used.'),
    invoiceLanguage: t('invoices.invoiceLanguage', 'Default invoice language'),
    invoiceLanguageDescription: t('invoices.invoiceLanguageDescription', 'Used for invoice emails and the public payment page. Players with a language preference on their account get invoices in their own language.'),
    forwardEmails: t('invoices.forwardEmails', 'Facturen doorsturen'),
    forwardEmailsDescription: t('invoices.forwardEmailsDescription', 'Betaalde facturen worden automatisch doorgestuurd naar deze e-mailadressen (bijv. boekhoudsoftware).'),
    renumberTitle: 'Facturen hernummeren?',
    renumberDescription: 'De factuurnummering is gewijzigd. Selecteer welke facturen hernummerd moeten worden. Betaalde facturen blijven altijd ongewijzigd.',
    renumberDraft: 'Concepten (draft)',
    renumberSent: 'Verzonden (sent)',
    renumberOverdue: 'Achterstallig (overdue)',
    renumberConfirm: 'Hernummeren',
    renumberCancel: 'Annuleren',
    renumberSuccess: (count) => `${count} facturen hernummerd`,
    renumberNothing: 'Geen facturen gevonden om te hernummeren',
    renumberError: 'Hernummeren mislukt',
  };

  return (
    <InvoiceSettingsCardBase
      ownerId={userId}
      table="trainer_profiles"
      ownerColumn="user_id"
      ownerType="trainer"
      buildLogoPath={(ext) => `invoice-logos/${userId}.${ext}`}
      labels={labels}
      idPrefix="tr"
      onSave={onSave}
    />
  );
}
