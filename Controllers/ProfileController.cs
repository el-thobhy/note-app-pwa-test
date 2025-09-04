using Microsoft.AspNetCore.Mvc;
using NoteAppPWA.Controllers;

namespace NoteApp.Controllers
{
    public class ProfileController : BaseController
    {
        public IActionResult Index()
        {
            return View();
        }
    }
}
