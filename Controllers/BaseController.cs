using ELAuth.Helper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace NoteAppPWA.Controllers
{
    public class BaseController : Controller
    {
        protected string? Token { get; private set; }
        protected string[] Roles { get; private set; } = Array.Empty<string>();
        protected string? UserId { get; private set; }

        public override void OnActionExecuting(ActionExecutingContext context)
        {
            base.OnActionExecuting(context);

            Token = HttpContext.Session.GetString("Token");

            if (string.IsNullOrEmpty(Token))
            {
                context.Result = RedirectToAction("Index", "Auth");
                return;
            }

            Roles = JwtHelper.GetRolesFromToken(Token) ?? Array.Empty<string>();
            HttpContext.Session.SetString("Roles", string.Join(",", Roles));
            UserId = JwtHelper.GetName(Token);
        }
    }

}
