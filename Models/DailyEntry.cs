using System.Web.Mvc;

namespace NoteApp.Models
{
    public class DailyEntry : BaseProperties
    {
        public int Id { get; set; }
        public int NoteId { get; set; }
        public string Date { get; set; }
        public string Title_Note { get; set; }
        public string WH_start { get; set; }
        public string WH_end { get; set; }
        public string OT_start { get; set; }
        public string OT_end { get; set; }
        public string Total_WH { get; set; }
        public string Total_OT { get; set; }
        public string Status_absen { get; set; }
        [AllowHtml]
        public string Content { get; set; }
        public string UserId { get; set; }
    }

}
