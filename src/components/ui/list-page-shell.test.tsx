import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListPageShell, ListPageState } from './list-page-shell';

describe('ListPageState', () => {
  const Content = () => <div>READY_CONTENT</div>;
  const Empty = () => <div>EMPTY_NODE</div>;

  it('renders children in the ready state', () => {
    render(<ListPageState><Content /></ListPageState>);
    expect(screen.getByText('READY_CONTENT')).toBeInTheDocument();
  });

  it('renders the empty node when isEmpty (not the children)', () => {
    render(<ListPageState isEmpty empty={<Empty />}><Content /></ListPageState>);
    expect(screen.getByText('EMPTY_NODE')).toBeInTheDocument();
    expect(screen.queryByText('READY_CONTENT')).not.toBeInTheDocument();
  });

  it('renders the error alert with precedence over empty and content', () => {
    render(
      <ListPageState isEmpty error="BOOM" empty={<Empty />}>
        <Content />
      </ListPageState>,
    );
    expect(screen.getByText('BOOM')).toBeInTheDocument();
    expect(screen.queryByText('EMPTY_NODE')).not.toBeInTheDocument();
    expect(screen.queryByText('READY_CONTENT')).not.toBeInTheDocument();
  });

  it('loading takes precedence over error, empty and content', () => {
    render(
      <ListPageState isLoading isEmpty error="BOOM" empty={<Empty />}>
        <Content />
      </ListPageState>,
    );
    expect(screen.queryByText('BOOM')).not.toBeInTheDocument();
    expect(screen.queryByText('EMPTY_NODE')).not.toBeInTheDocument();
    expect(screen.queryByText('READY_CONTENT')).not.toBeInTheDocument();
  });

  it('uses a custom loadingFallback when provided', () => {
    render(
      <ListPageState isLoading loadingFallback={<div>CUSTOM_LOADER</div>}>
        <Content />
      </ListPageState>,
    );
    expect(screen.getByText('CUSTOM_LOADER')).toBeInTheDocument();
  });
});

describe('ListPageShell', () => {
  it('renders the title, headerAfter and children in the ready state', () => {
    render(
      <ListPageShell title="My list" headerAfter={<p>HINT</p>}>
        <div>BODY</div>
      </ListPageShell>,
    );
    expect(screen.getByText('My list')).toBeInTheDocument();
    expect(screen.getByText('HINT')).toBeInTheDocument();
    expect(screen.getByText('BODY')).toBeInTheDocument();
  });

  it('renders only the loading fallback when isLoading (no header/children)', () => {
    render(
      <ListPageShell title="My list" isLoading loadingFallback={<div>LOADING</div>}>
        <div>BODY</div>
      </ListPageShell>,
    );
    expect(screen.getByText('LOADING')).toBeInTheDocument();
    expect(screen.queryByText('My list')).not.toBeInTheDocument();
    expect(screen.queryByText('BODY')).not.toBeInTheDocument();
  });
});
