import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/store/theme";

type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps) {
  const theme = useTheme((s) => s.theme);
  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      toastOptions={{
        classNames: {
          toast:
            "rounded-md border border-border bg-popover text-popover-foreground shadow-md",
        },
      }}
      {...props}
    />
  );
}
