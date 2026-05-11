using Microsoft.AspNetCore.Mvc;

namespace NoteAppPWA.Controllers
{
    public class DocumentController : Controller
    {
        public IActionResult Index()
        {
            return View();
        }
        public IActionResult Editor(string id = "default")
        {
            ViewBag.DocId = id;
            return View();
        }
    }
}
