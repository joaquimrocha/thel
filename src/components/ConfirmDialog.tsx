import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";

export function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm);
  const clear = useUI((s) => s.clearConfirm);
  const [checked, setChecked] = useState(false);

  // Reset the checkbox to the request's default each time a new confirm opens.
  useEffect(() => {
    setChecked(confirm?.checkbox?.defaultChecked ?? false);
  }, [confirm]);

  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open) clear();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          {confirm?.description && (
            <DialogDescription>{confirm.description}</DialogDescription>
          )}
        </DialogHeader>
        {confirm?.checkbox && (
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={checked}
                onCheckedChange={(v) => setChecked(v === true)}
              />
              {confirm.checkbox.label}
            </label>
            {confirm.checkbox.warning && checked && (
              <p className="pl-6 text-xs text-destructive">
                {confirm.checkbox.warning}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={clear}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              confirm?.onConfirm(checked);
              clear();
            }}
          >
            {confirm?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
