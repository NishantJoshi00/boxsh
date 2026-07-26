import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Cpu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { listModels, type Provider } from "@/lib/models";
import { shortcut } from "@/lib/shortcuts";
import { useStudio, type AgentSession } from "@/lib/store";
import { cn } from "@/lib/utils";

const assetBase = import.meta.env.BASE_URL.replace(/\/?$/, "/");

const PROVIDERS: {
  id: Provider;
  label: string;
  logo: string;
  logoClassName: string;
  buttonClassName: string;
}[] = [
  {
    id: "anthropic",
    label: "Claude",
    logo: `${assetBase}brand/claude.svg`,
    logoClassName: "size-full",
    buttonClassName: "bg-muted hover:bg-muted/80",
  },
  {
    id: "openai",
    label: "OpenAI",
    logo: `${assetBase}brand/openai.svg`,
    logoClassName: "size-9",
    buttonClassName: "bg-white hover:bg-white/90",
  },
];

function ProviderChoice({
  provider,
  onSelect,
}: {
  provider: (typeof PROVIDERS)[number];
  onSelect: (provider: Provider) => void;
}) {
  return (
    <div className="grid justify-items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "size-20 overflow-hidden rounded-full p-0",
          provider.buttonClassName,
        )}
        aria-label={`Show ${provider.label} models`}
        onClick={() => onSelect(provider.id)}
      >
        <img
          src={provider.logo}
          alt=""
          className={provider.logoClassName}
          aria-hidden="true"
        />
      </Button>
      <span className="text-sm text-muted-foreground">{provider.label}</span>
    </div>
  );
}

export function ModelPickerDialog({ session }: { session: AgentSession }) {
  const keys = useStudio((state) => state.keys);
  const lastModels = useStudio((state) => state.lastModels);
  const setSessionModel = useStudio((state) => state.setSessionModel);
  const setSessionProvider = useStudio((state) => state.setSessionProvider);
  const setKeysOpen = useStudio((state) => state.setKeysOpen);
  const modelPickerSessionId = useStudio((state) => state.modelPickerSessionId);
  const setModelPickerSessionId = useStudio((state) => state.setModelPickerSessionId);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<Partial<Record<Provider, string[]>>>({});
  const [loading, setLoading] = useState<Set<Provider>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeModelRef = useRef<HTMLButtonElement>(null);
  const open = modelPickerSessionId === session.id;

  const loadModels = useCallback(
    async (nextProvider: Provider, force = false) => {
      const key = keys[nextProvider];
      if (!key) return;
      setLoading((current) => new Set(current).add(nextProvider));
      setErrors((current) => ({ ...current, [nextProvider]: undefined }));
      try {
        const found = await listModels(nextProvider, key, force);
        setModels((current) => ({ ...current, [nextProvider]: found }));
      } catch (caught) {
        setErrors((current) => ({
          ...current,
          [nextProvider]: caught instanceof Error ? caught.message : String(caught),
        }));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(nextProvider);
          return next;
        });
      }
    },
    [keys],
  );

  const chooseProvider = (nextProvider: Provider) => {
    setProvider(nextProvider);
    setQuery("");
    setActiveIndex(0);
    if (!models[nextProvider]) void loadModels(nextProvider);
  };

  const options = useMemo(() => {
    if (!provider) return [];
    const found = models[provider] ?? [];
    const fallback = lastModels[provider];
    const all = found.includes(fallback) ? found : [fallback, ...found];
    const normalized = query.trim().toLowerCase();
    return normalized ? all.filter((id) => id.toLowerCase().includes(normalized)) : all;
  }, [lastModels, models, provider, query]);

  useEffect(() => {
    activeModelRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, options]);

  const selectModel = (model: string) => {
    if (!provider) return;
    setSessionProvider(session.id, provider);
    setSessionModel(session.id, model);
    setModelPickerSessionId(null);
  };

  const changeOpen = (next: boolean) => {
    setModelPickerSessionId(next ? session.id : null);
    if (next) {
      setProvider(null);
      setQuery("");
      setActiveIndex(0);
    }
  };

  const providerLabel = PROVIDERS.find((item) => item.id === provider)?.label;
  const hasKey = provider ? Boolean(keys[provider]) : false;
  const error = provider ? errors[provider] : undefined;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 min-w-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => changeOpen(true)}
      >
        <Cpu />
        <span className="max-w-48 truncate">{session.model}</span>
        <Kbd className="h-4 min-w-0 bg-transparent px-0 text-[10px] opacity-60">
          {shortcut("model-picker").keys.join(" ")}
        </Kbd>
      </Button>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-2">
              {provider && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 -mt-1 shrink-0"
                  aria-label="Back to providers"
                  onClick={() => {
                    setProvider(null);
                    setQuery("");
                    setActiveIndex(0);
                  }}
                >
                  <ArrowLeft />
                </Button>
              )}
              <div className="grid gap-1">
                <DialogTitle>{provider ? `${providerLabel} models` : "Choose a provider"}</DialogTitle>
                <DialogDescription>
                  {provider
                    ? "Search the models available to your API key."
                    : "Choose where this session should run."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {!provider ? (
            <div className="grid grid-cols-2 justify-items-center gap-10 py-7">
              {PROVIDERS.map((item) => (
                <ProviderChoice key={item.id} provider={item} onSelect={chooseProvider} />
              ))}
            </div>
          ) : !hasKey ? (
            <div className="flex items-center justify-between gap-4 py-3">
              <p className="text-sm text-muted-foreground">
                Add your {providerLabel} API key to list its models.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setModelPickerSessionId(null);
                  setKeysOpen(true);
                }}
              >
                Add key
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  role="combobox"
                  aria-controls={`${session.id}-model-options`}
                  aria-expanded="true"
                  aria-activedescendant={
                    options[activeIndex]
                      ? `${session.id}-model-option-${activeIndex}`
                      : undefined
                  }
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveIndex((current) =>
                        options.length ? Math.min(current + 1, options.length - 1) : 0,
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveIndex((current) => Math.max(current - 1, 0));
                    } else if (event.key === "Enter" && options[activeIndex]) {
                      event.preventDefault();
                      selectModel(options[activeIndex]);
                    }
                  }}
                  placeholder="Search models"
                  className="pl-8"
                />
              </div>

              {loading.has(provider) && !models[provider] ? (
                <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Loading models…
                </div>
              ) : error ? (
                <div className="flex items-center justify-between gap-4 py-3">
                  <p className="min-w-0 truncate text-sm text-destructive">{error}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadModels(provider, true)}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <ScrollArea className="h-72">
                  <div
                    id={`${session.id}-model-options`}
                    role="listbox"
                    className="grid gap-0.5 pr-3"
                  >
                    {options.map((model, index) => {
                      const selected =
                        session.provider === provider && session.model === model;
                      const active = index === activeIndex;
                      return (
                        <Button
                          key={model}
                          ref={active ? activeModelRef : undefined}
                          id={`${session.id}-model-option-${index}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          variant="ghost"
                          className={cn(
                            "h-auto min-h-8 w-full justify-start px-2 py-1.5 font-mono text-xs font-normal",
                            active && "bg-accent text-accent-foreground",
                          )}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => selectModel(model)}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">{model}</span>
                          {selected && <Check className="size-3.5 text-muted-foreground" />}
                        </Button>
                      );
                    })}
                    {options.length === 0 && (
                      <p className="py-5 text-center text-sm text-muted-foreground">
                        No matching models.
                      </p>
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
