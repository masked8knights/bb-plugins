// BB supplies the sonner runtime through its plugin shim.
declare module "sonner" {
  interface ToastOptions {
    description?: string;
    duration?: number;
    position?: string;
  }
  export function toast(message: string, options?: ToastOptions): void;
  export namespace toast {
    function success(message: string, options?: ToastOptions): void;
    function error(message: string, options?: ToastOptions): void;
    function warning(message: string, options?: ToastOptions): void;
    function info(message: string, options?: ToastOptions): void;
    function message(message: string, options?: ToastOptions): void;
  }
}
