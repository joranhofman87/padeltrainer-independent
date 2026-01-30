import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { getReviewTags, type ReviewTag } from '@/lib/reviews';

interface ReviewTagSelectorProps {
  selectedTags: string[];
  onChange: (tagIds: string[]) => void;
}

const CATEGORY_ORDER = ['teaching_style', 'skill_focus', 'specialties'];

const CATEGORY_LABELS: Record<string, { en: string; nl: string }> = {
  teaching_style: { en: 'Teaching Style', nl: 'Lesstijl' },
  skill_focus: { en: 'Skill Focus', nl: 'Vaardigheden' },
  specialties: { en: 'Specialties', nl: 'Specialisaties' },
};

export function ReviewTagSelector({ selectedTags, onChange }: ReviewTagSelectorProps) {
  const { i18n } = useTranslation();
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTags() {
      const { data } = await getReviewTags();
      if (data) {
        setTags(data);
      }
      setLoading(false);
    }
    fetchTags();
  }, []);

  const toggleTag = (tagId: string) => {
    if (selectedTags.includes(tagId)) {
      onChange(selectedTags.filter(id => id !== tagId));
    } else {
      onChange([...selectedTags, tagId]);
    }
  };

  const getTagName = (tag: ReviewTag) => {
    return i18n.language === 'nl' ? tag.name_nl : tag.name;
  };

  const getCategoryLabel = (category: string) => {
    const labels = CATEGORY_LABELS[category];
    if (!labels) return category;
    return i18n.language === 'nl' ? labels.nl : labels.en;
  };

  // Group tags by category
  const groupedTags = CATEGORY_ORDER.reduce((acc, category) => {
    const categoryTags = tags.filter(t => t.category === category);
    if (categoryTags.length > 0) {
      acc[category] = categoryTags;
    }
    return acc;
  }, {} as Record<string, ReviewTag[]>);

  if (loading) {
    return null;
  }

  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <Label>Tags (optional)</Label>
      <p className="text-xs text-muted-foreground -mt-1">
        Select qualities that describe your trainer
      </p>
      <div className="space-y-3">
        {Object.entries(groupedTags).map(([category, categoryTags]) => (
          <div key={category}>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {getCategoryLabel(category)}
            </p>
            <div className="flex flex-wrap gap-2">
              {categoryTags.map(tag => (
                <Badge
                  key={tag.id}
                  variant={selectedTags.includes(tag.id) ? 'default' : 'outline'}
                  className="cursor-pointer hover:bg-primary/80 transition-colors"
                  onClick={() => toggleTag(tag.id)}
                >
                  {getTagName(tag)}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
