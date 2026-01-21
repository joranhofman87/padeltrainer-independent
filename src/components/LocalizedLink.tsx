import { Link, LinkProps } from 'react-router-dom';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';

interface LocalizedLinkProps extends Omit<LinkProps, 'to'> {
  to: string;
}

/**
 * A Link component that automatically adds the language prefix
 * Use this for all internal marketing page links
 */
export function LocalizedLink({ to, children, ...props }: LocalizedLinkProps) {
  const localizedPath = useLocalizedPath(to);
  
  return (
    <Link to={localizedPath} {...props}>
      {children}
    </Link>
  );
}
