using Microsoft.AspNetCore.Mvc;

namespace NoteApp.Controllers
{
    public class SignUpController : Controller
    {
        public IActionResult Index()
        {
            return View();
        }
        public IActionResult OtpVerification()
        {
            return View();
        }
    }
}
