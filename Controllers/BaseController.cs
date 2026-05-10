using ELAuth.Helper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using System.Security.Claims;

namespace NoteAppPWA.Controllers
{
    [Authorize(Roles = "User,Admin")]
    public class BaseController : Controller
    {
        protected string? Token { get; private set; }
        protected string[] Roles { get; private set; } = Array.Empty<string>();
        protected string? UserId { get; private set; }

        public override void OnActionExecuting(ActionExecutingContext context)
        {
            base.OnActionExecuting(context);

            var user = HttpContext.User;

            if(user?.Identity?.IsAuthenticated != true)
            {
                // Jika user tidak terautentikasi, redirect ke halaman login
                context.Result = RedirectToAction("Index", "Auth");
                return;
            }
            // Ambil token dari cookie
            Token = User?.FindFirst("Token")?.Value;

            Roles = user?.FindAll(ClaimTypes.Role)?.Select(r => r.Value)?.ToArray();
            UserId = user?.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? user?.FindFirst(ClaimTypes.Name)?.Value;
        }
    }

}
