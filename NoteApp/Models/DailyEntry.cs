using System.Web.Mvc;

namespace NoteApp.Models
{
    public class DailyEntry : BaseProperties
    {
        public int Id { get; set; }
        public int NoteId { get; set; }
        public string Date { get; set; }
        public string Title_Note { get; set; }
        [AllowHtml]
        public string Content { get; set; }
        public string UserId { get; set; }
    }

}
